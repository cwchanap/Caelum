# HPA-626 Metro Headway and Initial Fleet Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Metro use the same pre-deployment headway and deterministic initial-fleet loop as Bus, with both route types fleet-free at creation and Rust remaining the authority for timing, fleet count, deploy cost, placement, and restore validity.

**Architecture:** Rename HPA-624's `bus_service` module to `service_control` at the start, then widen only the existing seams that now have Bus and Metro consumers. Product service commands are keyed by line ID, matching other route intents; mode is derived internally from whether the ID belongs to `routes` or `metro_lines`. Persist only a nullable target on each route type; publish serialize-only `ServiceMetrics`, including Rust-derived estimated deployment cost. Keep `AssignVehicle` as the low-level fixture seam and add no `ServicePlan`, scheduler, trait hierarchy, fleet manager, or post-deployment fleet controls.

**Tech Stack:** Rust (`caelum-core`, serde), Svelte 5 + TypeScript, existing WASM/Tauri `GameBackend.dispatch`, Vitest, Playwright, Bun, IndexedDB, native Tauri application-data persistence.

## Global Constraints

- HPA-626 only; HPA-334 remains the coordination parent.
- New Bus and Metro routes both start with zero fleet and zero route-creation vehicle purchase.
- Product service commands use `lineId` only; do not carry a redundant `mode` field.
- Persist one required-nullable `targetHeadwaySeconds` on each route type.
- Derived `serviceMetrics` is output only and is never save authority.
- `ServiceMetrics` includes `estimatedDeploymentCost`; Rust computes it from current required fleet and `vehicle_cost(mode)`.
- Direct schema/storage break to v8; no migration, fallback namespace, compatibility alias, or dual reader.
- Minimum target headway is `60s`; restore and player mutations enforce the same floor.
- Target headway is pre-deployment only; once any vehicle exists, no target editing in HPA-626.
- Required fleet is `max(1, ceil(roundTripSeconds / targetHeadwaySeconds))`.
- UI calls `roundTrip / assignedFleet` **Nominal headway**, never Current/Actual.
- Cycle math and deterministic placement use `current_path` and live `vehicle_step_seconds` only.
- Bus remains congestion-aware; Metro track timing remains independent of `RoadFlow`.
- Initial deployment is one-shot, zero-fleet only, and atomic through existing `CostPolicy`.
- Keep low-level `AssignVehicle`; add no player plus-one vehicle control.
- Preserve structural route-edit rebase; do not resize/re-space after edits.
- Delete route-preview `initialVehicleCost` / `affordable` and route-only `WarningCode::InsufficientBudget` after Metro creation stops buying a train.
- Preserve ordinary `RejectionCode::InsufficientBudget`, including road-mutation preview handling.
- TypeScript performs no service timing, fleet-count, or vehicle-cost formula.
- Geometry-only Metro tests become `No fleet`; only tests that need live/routable service receive a vehicle.
- No service bands, closed periods, timetables, actual-departure history, holding/bunching, fleet top-up/withdrawal/reassignment/refund, depots, route visibility framework, or generic service-plan/scheduler abstraction.

## File Structure

**Rename in Task 1**

- `crates/caelum-core/src/bus_service.rs` -> `crates/caelum-core/src/service_control.rs`
- `crates/caelum-core/tests/bus_service.rs` -> `crates/caelum-core/tests/service_control.rs`

**Rust core**

- `crates/caelum-core/src/model.rs` — v8; `ServiceMetrics`; Metro target/metrics fields.
- `crates/caelum-core/src/lib.rs` — register `service_control`.
- `crates/caelum-core/src/engine.rs` — generic snapshot metrics and service intent dispatch.
- `crates/caelum-core/src/intent.rs` — line-ID-keyed generic service intents.
- `crates/caelum-core/src/service_control.rs` — target validation, shared metrics, cost estimate, placement, deployment.
- `crates/caelum-core/src/route_editor.rs` — initialize Metro v8 fields, later remove implicit train/cost.
- `crates/caelum-core/src/preview.rs` — later remove route vehicle affordability only.
- `crates/caelum-core/src/router.rs` — zero-fleet passenger gate for both modes.
- `crates/caelum-core/src/persistence/entities.rs` — Bus/Metro restore floor + metric clearing.
- `crates/caelum-core/src/transit.rs` — reuse `vehicle_step_seconds`, `initial_vehicle`, `vehicle_cost`, `AssignVehicle`.
- Tests: `model_wire_format.rs`, `service_control.rs`, `route_preview.rs`, `transit_build.rs`, `transit_router.rs`, `router_planning.rs`, `economy_cost_policy.rs`, `golden_sequences.rs`, `route_editing.rs`, `shuttle_service.rs`, `route_resilience.rs`, `platforms.rs`, `engine_smoke.rs`, persistence tests, and any additional Metro fixture found by the inventory.

**TypeScript/UI/hosts**

- `src/domain/types.ts` — v8, `ServiceMetrics`, Metro target/metrics.
- `src/runtime/backend/types.ts` — raw Metro fields, generic line-ID intents, reduced preview response.
- `src/runtime/snapshotView.ts` — normalize Bus/Metro target/metrics.
- `src/runtime/types.ts` — line-ID runtime methods + `ShellServiceState`.
- `src/runtime/createGameRuntime.ts` — generic service dispatch.
- `src/runtime/runtimeSelectors.ts` — mode-neutral No fleet/service state; remove preview affordability branch.
- `src/runtime/rejectionMessages.ts` — remove only dead route-preview warning handling.
- `src/components/hud/panels/LinesPanel.svelte`, `src/App.svelte`, `src/styles.css` — shared service UI and Rust-derived estimated cost.
- `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs` — v8 namespaces.
- `CLAUDE.md` — remove stale literal schema version; point to Rust constant.
- `docs/architecture.md` — active v8/service-control description.
- Tests: `tests/runtime/gameRuntime.test.ts`, `runtimeSelectors.test.ts`, `rejectionMessages.test.ts`, `snapshotView.test.ts`, persistence tests, `tests/ui/linesPanel.test.ts`, `appShell.test.ts`, `tests/e2e/routes.spec.ts`, `tests/e2e/newCity.spec.ts`, fixtures/helpers.

---

## Task 1: Rename the service module and make the v8 wire/storage/restore break

**Files:**
- Rename: `crates/caelum-core/src/bus_service.rs` -> `crates/caelum-core/src/service_control.rs`
- Rename: `crates/caelum-core/tests/bus_service.rs` -> `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/src/route_editor.rs` only to initialize new Metro fields; keep its implicit train/cost in this task
- Modify: `crates/caelum-core/src/engine.rs` comments/imports only
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: direct `Route {}` / `MetroLine {}` fixtures found by compile
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts` raw snapshot types only
- Modify: `src/runtime/snapshotView.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: `tests/runtime/snapshotView.test.ts`
- Modify: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Modify: `tests/e2e/newCity.spec.ts` if it hardcodes the old DB name
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`

**Produces:**

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;

pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub estimated_deployment_cost: Option<i32>,
    pub nominal_headway_seconds: Option<f64>,
}
```

Both `Route` and `MetroLine` have required-nullable `target_headway_seconds` and serialize-only `service_metrics`.

- [ ] **Step 1: Rename the Bus module/tests before writing new references**

```bash
git mv crates/caelum-core/src/bus_service.rs crates/caelum-core/src/service_control.rs
git mv crates/caelum-core/tests/bus_service.rs crates/caelum-core/tests/service_control.rs
```

Update `lib.rs`, existing imports, and the constant name:

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;
```

Do not change Bus behavior yet.

- [ ] **Step 2: Write failing v8 Metro wire tests**

In `model_wire_format.rs` assert:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 8);
```

A serialized Metro line must contain:

```json
"targetHeadwaySeconds": null
```

Removing the key must make v8 deserialization fail; `null` must load. A forged non-null `serviceMetrics` object must deserialize to `None` authority.

- [ ] **Step 3: Write failing Metro restore-floor tests beside the existing Bus regressions**

For a real Metro line:

```rust
state.transit.metro_lines[0].target_headway_seconds = Some(59);
```

`GameEngine::from_snapshot` must reject with:

```text
code = invalidNumericValue
entity.kind = metroLine
field = routeTargetHeadway
reason.kind = outOfRange
minimum = 60
actual = 59
```

Then prove `Some(60)` restores.

Keep existing Bus 59/60 tests green, now referencing `service_control::MIN_HEADWAY_SECONDS`.

- [ ] **Step 4: Update model + production/direct literals**

Set:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 8;
```

Rename `BusServiceMetrics` -> `ServiceMetrics` and add `estimated_deployment_cost`.

Add to the production Metro branch in `route_editor::insert_route` and every direct Metro literal:

```rust
target_headway_seconds: None,
service_metrics: None,
```

Keep the current implicit Metro train in Task 1.

- [ ] **Step 5: Extend restore validation and metric clearing**

After Metro `validate_route_shape`, apply the same target floor as Bus using:

```rust
crate::service_control::MIN_HEADWAY_SECONDS
EntityKind::MetroLine
SnapshotField::RouteTargetHeadway
```

Clear derived metrics from both `routes` and `metro_lines` in the existing normalizer.

- [ ] **Step 6: Update canonical/raw TS shapes and storage namespaces**

Use:

```ts
export const SNAPSHOT_SCHEMA_VERSION = 8 as const;
```

`ServiceMetrics` includes:

```ts
estimatedDeploymentCost: number | null;
```

Both route types have canonical target/metrics; raw host types allow omitted/undefined derived output.

Storage:

```text
caelum-city-saves-v8
DATABASE_VERSION = 8
cities-v8
```

Update `tests/e2e/newCity.spec.ts` if it names the database directly.

- [ ] **Step 7: Remove the stale schema number from CLAUDE.md**

Replace the convention that hardcodes `SNAPSHOT_SCHEMA_VERSION = 4` with guidance equivalent to:

```text
The authoritative development schema version is
crates/caelum-core/src/model.rs::SNAPSHOT_SCHEMA_VERSION.
Hosts reject older versions; development saves are disposable.
```

Do not write `= 8` into CLAUDE.md.

- [ ] **Step 8: Run a leftover scan that actually matches typed Rust constants**

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION\b[^\n]*\b7\b|schemaVersion[^\n]*\b7\b|cities-v7|caelum-city-saves-v7|schema-?v?7' \
  crates src src-tauri tests CLAUDE.md docs/architecture.md
```

Expected: no active v7 matches. Historical specs/plans are intentionally excluded.

- [ ] **Step 9: Run full Task-1 gates, not compile-only checks**

```bash
cargo test -p caelum-core
bun run test:unit
bun run check
cargo test -p caelum_lib city_store
```

Expected: all pass with Metro creation behavior still unchanged.

- [ ] **Step 10: Commit**

```bash
git add crates/caelum-core src src-tauri tests CLAUDE.md docs/architecture.md
git commit -m "feat: add metro service v8 contract"
```

---

## Task 2: Generalize service metrics/timing/routing to Bus and Metro

**Files:**
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`
- Modify: persistence snapshot tests if they own snapshot/save-output assertions

**Interfaces:**

Private helpers become mode-aware after mode is derived internally:

```rust
fn round_trip_seconds(
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
) -> Option<f64>;

fn resolve_service_cursor(
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
    offset_seconds: f64,
) -> Option<ServiceCursor>;
```

- [ ] **Step 1: Add failing Metro timing vectors**

Create Metro current track steps totaling 600s while `last_valid_path = 777s` and `estimated_seconds = 999s`; assert shared metrics use 600s.

Pass heavy `RoadFlow` at coincident points and assert Metro stays 600s.

Keep the existing Bus 302s free-flow / 402s congested shuttle vectors unchanged.

- [ ] **Step 2: Add shared required/nominal/cost/placement tests**

Lock:

```text
600 / 300 -> required 2
601 / 300 -> required 3
assigned 0 -> nominal None
600 / 2 assigned -> nominal 300
```

For Metro, `required = 3` must publish:

```text
estimated deployment cost = 3 * METRO_COST
```

from Rust.

Add unequal steps:

```text
100s + 300s = 400s cycle
fleet 2 -> second offset 200s
```

Second vehicle lands in step B with `step_progress = 100 / 300`.

- [ ] **Step 3: Add zero-fleet Metro passenger-routing tests**

```text
active + connected + zero Metro vehicles -> not routable
same line + low-level AssignVehicle -> routable
```

Keep `is_route_operational` structural.

- [ ] **Step 4: Implement one shared timing/metrics walker**

Reuse `transit::vehicle_step_seconds` for both modes; derive `RoadFlow` once in `populate_snapshot_metrics` and fill both route collections.

Compute `estimated_deployment_cost` only when target/required fleet exists and assigned fleet is zero, using checked conversion/multiplication with `transit::vehicle_cost(mode)`. Return `None` if the quote cannot be represented.

- [ ] **Step 5: Publish metrics only on output snapshots**

`GameEngine::snapshot()` fills both collections. `snapshot_for_save()` must still clear/omit both collections' metrics.

- [ ] **Step 6: Run full Task-2 gates**

```bash
cargo fmt --check
cargo test -p caelum-core
bun run test:unit
bun run check
```

Expected: all pass. Metro still has its implicit first train until Task 3B.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core src tests
git commit -m "refactor: share transit service metrics"
```

---

## Task 3A: Replace Bus-specific product commands with line-ID-keyed service commands

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/LinesPanel.svelte` callback names only
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: command-compile tests

**Produces:**

```rust
SetServiceTargetHeadway {
    line_id: String,
    target_headway_seconds: u32,
}
DeployInitialFleet {
    line_id: String,
}
```

No `mode` field.

- [ ] **Step 1: Write runtime intent-shape tests**

Bus calls must dispatch:

```ts
{
  type: "setServiceTargetHeadway",
  lineId: "route-001",
  targetHeadwaySeconds: 360,
}
```

and:

```ts
{ type: "deployInitialFleet", lineId: "route-001" }
```

No `mode` key is allowed.

- [ ] **Step 2: Implement ID-based service lookup**

Inside `service_control`, resolve `line_id` by collection ownership:

```text
routes contains id      -> TransitMode::Bus
metro_lines contains id -> TransitMode::Metro
neither                  -> RouteNotFound
```

Feed the derived mode to timing/cost helpers. Do not add a Walk branch or expose `route_view` across modules solely for reuse.

- [ ] **Step 3: Replace old Bus product names without compatibility aliases**

Delete:

```text
SetBusTargetHeadway
DeployBusFleet
setBusTargetHeadway
deployBusFleet
```

Keep low-level `AssignVehicle { mode, line_id }` unchanged.

- [ ] **Step 4: Run green gates**

```bash
cargo test -p caelum-core
bun run test:unit -- tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
```

Expected: existing Bus product behavior is unchanged; Metro creation still has its implicit train.

- [ ] **Step 5: Commit**

```bash
git add crates/caelum-core src tests
git commit -m "refactor: key service commands by line id"
```

---

## Task 3B: Make Metro creation fleet-free and migrate Metro service fixtures

**Files:**
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs` only to neutralize obsolete affordability during this intermediate commit
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`
- Modify: `crates/caelum-core/tests/router_planning.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/golden_sequences.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/shuttle_service.rs`
- Modify: `crates/caelum-core/tests/route_resilience.rs`
- Modify: `crates/caelum-core/tests/platforms.rs`
- Modify: `crates/caelum-core/tests/engine_smoke.rs`
- Modify: any additional Metro fixture found by inventory
- Modify: tests that inspect route preview affordability only enough to keep this intermediate commit behaviorally correct; full deletion is Task 3C

- [ ] **Step 1: Inventory Metro service assumptions before changing creation**

```bash
rg -n 'TransitMode::Metro|mode: "metro"|mode: TransitMode::Metro|METRO_COST|AssignVehicle|vehicle_ids|vehicleIds|primary: "running"|toHaveText\([^\n]*"Running"' \
  crates/caelum-core src tests
```

Classify each Metro match:

```text
needs moving/routable service -> explicit AssignVehicle unless testing HPA-626 service control
geometry/repair only          -> keep zero fleet
old Running caused only by implicit train -> retarget to No fleet later; do not inject a train
```

- [ ] **Step 2: Write failing zero-fleet creation + deploy-cost tests**

After Metro `CreateRoute`:

```rust
assert!(line.vehicle_ids.is_empty());
assert!(snapshot.transit.vehicles.is_empty());
assert_eq!(snapshot.budget, budget_before);
```

Set target by line ID, then Deploy and assert assigned fleet equals Rust-derived required fleet.

For Standard, exact deduction is `required * METRO_COST`. One dollar below the complete quote rejects atomically with zero inserted trains. Creative leaves budget unchanged.

- [ ] **Step 3: Remove Metro's implicit first vehicle/cost**

`create_route_costed` inserts `vehicle_ids: Vec::new()` for both Bus and Metro and charges no vehicle cost.

Do not remove low-level `assign_vehicle_costed`.

- [ ] **Step 4: Keep route preview semantically correct during this intermediate commit**

Metro creation is now free, so route preview must stop rejecting it for vehicle budget immediately. Until Task 3C deletes the dead API fields, return the neutral shape:

```text
initial_vehicle_cost = 0
affordable = true
no route-preview insufficient-budget warning
```

This is transitional within the branch only; Task 3C removes the fields. Do not add compatibility parsing or aliases.

- [ ] **Step 5: Migrate only fixtures that truly need live Metro service**

Use:

```rust
GameIntent::AssignVehicle {
    mode: "metro".to_string(),
    line_id: "metro-001".to_string(),
}
```

for unrelated routing/movement tests. Use Set -> Deploy only in HPA-626 service-control tests.

- [ ] **Step 6: Add deployed-Metro granularity regression**

Extend the existing `golden_sequences.rs` deployed-Bus pattern. Compare equal elapsed simulation under coarse vs fine ticks and assert equivalent train cursors/state.

- [ ] **Step 7: Run green gates**

```bash
cargo test -p caelum-core
bun run test:unit
bun run check
```

Expected: Metro is fleet-free and deployable; unrelated Metro tests explicitly state whether they need service; preview no longer falsely rejects free Metro creation.

- [ ] **Step 8: Commit**

```bash
git add crates/caelum-core src tests
git commit -m "feat: make metro creation fleet free"
```

---

## Task 3C: Delete dead route-preview vehicle affordability

**Files:**
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/route_preview.rs`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `tests/runtime/rejectionMessages.test.ts`
- Modify: route-preview fixtures/tests under `tests/runtime` / `tests/ui`

**Produces geometry-only route preview:**

```rust
pub struct RoutePreviewResponse {
    pub generation: u64,
    pub legs: Vec<RouteLegPath>,
    pub total_travel_seconds: f64,
    pub turn_summary: TurnSummary,
    pub missing_waypoint_ids: Vec<String>,
    pub warnings: Vec<GameplayWarning>,
    pub rejection: Option<GameplayRejection>,
}
```

- [ ] **Step 1: Delete the dead Rust preview fields and route-only warning**

Remove:

```text
initial_vehicle_cost
affordable
route CostPolicy quote
route-preview WarningCode::InsufficientBudget
its sole warning producer
```

Do not touch `RejectionCode::InsufficientBudget` or `rejected_road_preview` budget behavior.

- [ ] **Step 2: Replace old Metro affordability tests with geometry-only regressions**

With budget `0`, a structurally valid Metro preview must still return connected legs and no budget rejection.

Keep route topology/revision/failure tests.

- [ ] **Step 3: Delete TypeScript affordability fields/presentation**

Remove `initialVehicleCost`, `affordable`, and:

```ts
if (!preview.affordable) {
  return { status: "rejected", message: `Need ${formatBudget(preview.initialVehicleCost)}.` };
}
```

Remove only dead route-preview warning message/tests; preserve normal gameplay budget rejection messages.

- [ ] **Step 4: Run narrow cleanup scans**

```bash
rg -n 'initial_vehicle_cost|WarningCode::InsufficientBudget' \
  crates/caelum-core/src/preview.rs crates/caelum-core/tests/route_preview.rs

rg -n 'initialVehicleCost|\.affordable' \
  src/runtime/backend/types.ts src/runtime/runtimeSelectors.ts tests/runtime tests/ui
```

Expected: no matches.

Do not use generic `InsufficientBudget` as a cleanup search term.

- [ ] **Step 5: Run green gates**

```bash
cargo test -p caelum-core
bun run test:unit
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core src tests
git commit -m "refactor: remove route preview vehicle affordability"
```

---

## Task 4: Reuse one service presentation and setup flow for Bus and Metro

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css` only if necessary
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interface:**

```ts
export interface ShellServiceState {
  targetHeadwaySeconds: number | null;
  roundTripSeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  estimatedDeploymentCost: number | null;
  nominalHeadwaySeconds: number | null;
}
```

Every supported route row carries `service: ShellServiceState`.

- [ ] **Step 1: Write failing selector tests for mode-neutral No fleet and service state**

An active connected Metro with `vehicleIds: []` must select `status.primary === "noFleet"` and pass through Rust metrics including `estimatedDeploymentCost`.

After vehicles exist, status is `running` and nominal is passed through unchanged.

Retarget the existing empty-fleet Metro selector assertion from `running` / `busService: null` to `noFleet` / generic `service`.

- [ ] **Step 2: Write failing LinesPanel tests for Metro setup + quoted estimate**

Before deployment, assert:

```text
No fleet
Target
Required
train/trains
Est. deploy cost
Deploy fleet · est. $...
```

The amount must come from `route.service.estimatedDeploymentCost`; the component must not multiply fleet count by a local cost constant.

After deployment, assert only Target/Nominal/Fleet and no setup controls.

Retarget the existing Metro test that expects no service block.

- [ ] **Step 3: Rename shell presentation names**

```text
ShellBusServiceState -> ShellServiceState
busService           -> service
selectBusServiceState -> selectServiceState
```

`selectServiceState` only copies route/Metro fields and Rust metrics.

- [ ] **Step 4: Make No fleet status mode-neutral**

```ts
if (route.pathBroken) return broken;
if (!route.active) return paused;
if (route.vehicleIds.length === 0) return noFleet;
return running;
```

- [ ] **Step 5: Reuse the existing setup markup for both modes**

Use one `fleetNoun(mode, count)` helper for copy only.

Set callback:

```ts
onSetServiceTargetHeadway(route.id, minutes * 60)
```

Deploy callback:

```ts
onDeployInitialFleet(route.id)
```

Display the button label from Rust-provided estimated cost, for example:

```text
Deploy fleet · est. $150,000
```

If estimate is `null`, fall back to `Deploy fleet`.

- [ ] **Step 6: Keep deployed UI read-only**

After any assigned fleet exists, show Target/Nominal/Fleet only.

- [ ] **Step 7: Verify line-ID-only runtime dispatch**

`gameRuntime.test.ts` must assert service intents contain no `mode` key for both Bus and Metro line IDs.

- [ ] **Step 8: Run UI/runtime gates**

```bash
bun run test:unit -- tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
```

Expected: both modes use one service row and zero-fleet Metro is `No fleet`.

- [ ] **Step 9: Commit**

```bash
git add src tests/runtime tests/ui
git commit -m "feat: configure metro service from lines panel"
```

---

## Task 5: Prove the real Metro setup loop and run final regression verification

**Files:**
- Modify: `tests/e2e/routes.spec.ts`
- Modify other files only for concrete regressions exposed by verification

- [ ] **Step 1: Retarget the existing Metro station-repair E2E**

The repair test is geometry-only. After rebuilding the station, change the old final expectation:

```text
Running
```

to:

```text
No fleet
```

Do not add `AssignVehicle` or Deploy merely to preserve the old label.

Update its budget comment: route creation no longer spends one `METRO_COST`.

- [ ] **Step 2: Add one real Metro Set -> Deploy E2E with explicit budget provisioning**

Reuse the existing Metro track/station layout helpers.

Sequence:

```text
create/open sandbox
lay connected track
place two Metro stations
create/save Metro line
assert No fleet
assert vehicleIds = []
set target
assert Required count from UI
assert estimated deploy cost from UI
debugSetBudget(page, 500_000) before Deploy
click Deploy
assert non-empty vehicleIds
assert Target/Nominal/Fleet visible and setup controls gone
Resume
assert clock advances
```

Choose a target on the short existing test layout that makes the required count deterministic (prefer a sufficiently large whole-minute target so `Required 1 train` / estimated `$50,000` is stable). Assert the UI value; do not reproduce the fleet formula in Playwright.

- [ ] **Step 3: Run focused route E2E**

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Expected: geometry repair ends at `No fleet`; Metro service startup succeeds with provisioned budget.

- [ ] **Step 4: Run complete verification**

```bash
cargo test --workspace
bun run test:unit
bun run check
bun run format:check
bun run lint
bun run test:e2e
```

Expected: all pass.

- [ ] **Step 5: Verify no active v7 leftovers with the corrected regex**

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION\b[^\n]*\b7\b|schemaVersion[^\n]*\b7\b|cities-v7|caelum-city-saves-v7|schema-?v?7' \
  crates src src-tauri tests CLAUDE.md docs/architecture.md
```

Expected: no active matches.

- [ ] **Step 6: Verify old Bus-only and redundant-mode product API is gone**

```bash
rg -n 'BusServiceMetrics|busService|ShellBusServiceState|SetBusTargetHeadway|DeployBusFleet|setBusTargetHeadway|deployBusFleet|SetServiceTargetHeadway[^\n]*mode|DeployInitialFleet[^\n]*mode' \
  crates src src-tauri tests
```

Expected: no active matches.

- [ ] **Step 7: Verify route-preview affordability is gone without touching road budget handling**

```bash
rg -n 'initial_vehicle_cost|WarningCode::InsufficientBudget' \
  crates/caelum-core/src/preview.rs crates/caelum-core/tests/route_preview.rs

rg -n 'initialVehicleCost|\.affordable' \
  src/runtime/backend/types.ts src/runtime/runtimeSelectors.ts tests/runtime tests/ui
```

Expected: no matches.

Do not grep generic `RejectionCode::InsufficientBudget` as a cleanup condition.

- [ ] **Step 8: Verify restore floor and stale CLAUDE schema literal**

```bash
rg -n 'MIN_BUS_HEADWAY_SECONDS|service_control::MIN_HEADWAY_SECONDS|RouteTargetHeadway|SNAPSHOT_SCHEMA_VERSION = 4' \
  crates/caelum-core/src/persistence/entities.rs crates/caelum-core/tests/service_control.rs CLAUDE.md
```

Expected:

```text
no MIN_BUS_HEADWAY_SECONDS
Bus and Metro restore checks reference service_control::MIN_HEADWAY_SECONDS
Bus and Metro 59/60 restore regressions cover RouteTargetHeadway
no stale literal schema version in CLAUDE.md
```

- [ ] **Step 9: Verify TypeScript does not own cost math**

Search the service UI/runtime for duplicated vehicle-cost arithmetic:

```bash
rg -n '8000|8_000|50000|50_000|requiredFleet\s*\*|required_fleet\s*\*' \
  src/runtime src/components tests/runtime tests/ui
```

Expected: no service-cost formula or copied vehicle constants. The UI reads `estimatedDeploymentCost` from Rust.

- [ ] **Step 10: Verify scope stayed lean**

Final diff must not introduce:

```text
ServicePlan persistence object
service-period/band collection
timetable/schedule engine
departure history or actual-headway metric
post-deployment target editing
fleet top-up/withdrawal/reassignment/refund
auto resize/re-spacing
holding/bunching logic
depot/crew/maintenance model
route trait hierarchy or fleet repository/manager
TypeScript timing/fleet/cost formula
route visibility/map-layer framework
save migration/fallback reader
player-facing AssignVehicle plus-one control
```

It must preserve:

```text
structural route-edit rebase
low-level AssignVehicle fixture seam
Bus congestion-aware timing
Metro fixed track timing
atomic CostPolicy deployment
road-preview RejectionCode::InsufficientBudget behavior
```

- [ ] **Step 11: Commit E2E/final regression fixes**

```bash
git add tests/e2e/routes.spec.ts
git commit -m "test: cover metro service startup loop"
```

## Plan Self-Review

- **API consistency:** Product service commands now follow existing route-intent convention: line ID only; no redundant mode/id mismatch state and no Walk branch.
- **Restore invariant:** Bus and Metro share the same 60-second persisted-target floor through `service_control::MIN_HEADWAY_SECONDS`.
- **Schema discipline:** Task 1 and Task 2 run full core + unit suites; the v7 scan matches typed Rust constants and hardcoded TS storage names.
- **Module rename:** `bus_service` is renamed at the start of Task 1, so the new restore check is written against its final module/constant name once.
- **Reviewable Task 3:** command rename, fleet-free creation/fixture migration, and preview API deletion are separate green sub-gates. Task 3B briefly neutralizes obsolete preview fields only to avoid an inconsistent intermediate product state; Task 3C deletes them immediately.
- **Cost UX:** the one-shot Metro purchase shows a Rust-derived estimated deployment cost before the click; TypeScript does not duplicate `METRO_COST` or `BUS_COST`.
- **E2E stability:** Metro service E2E provisions budget before Deploy and uses a target/layout with deterministic required count.
- **Status honesty:** geometry-only Metro tests become `No fleet`; only real service tests receive vehicles.
- **CLAUDE.md:** the stale schema literal is removed rather than bumped to another value that will drift.
- **YAGNI/KISS:** no service-plan framework, timetable, fleet manager, compatibility path, or post-deployment operational machinery is introduced.