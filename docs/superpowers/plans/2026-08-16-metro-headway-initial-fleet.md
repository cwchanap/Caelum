# HPA-626 Metro Headway and Initial Fleet Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Metro use the same pre-deployment headway and deterministic initial-fleet loop as Bus, so both route types are fleet-free at creation while Rust remains the only authority for service timing, fleet count, cost, placement, and restore validity.

**Architecture:** Promote HPA-624's Bus-only service helpers into one small mode-aware `service_control` module because Bus and Metro now provide two concrete consumers. Keep the persisted model flat: one nullable target on `Route` and `MetroLine`, with serialize-only derived `ServiceMetrics`. Extend the existing restore-time 60-second floor to Metro, replace Bus-specific product intents/runtime methods with one mode-aware command pair, remove route-preview vehicle affordability once neither mode buys a vehicle at creation, and reuse one Lines-row setup UI for both modes. Do not introduce a persisted `ServicePlan`, scheduler, fleet manager, timetable, route trait hierarchy, or post-deployment fleet controls.

**Tech Stack:** Rust (`caelum-core`, serde), Svelte 5 + TypeScript, existing WASM/Tauri `GameBackend.dispatch`, Vitest, Playwright, Bun, IndexedDB, native Tauri application-data persistence.

## Global Constraints

- HPA-626 only; HPA-334 remains the coordination parent.
- Preserve HPA-624 Bus behavior while generalizing only seams with two real consumers.
- New Bus and Metro routes both start with zero fleet and zero vehicle purchase at route creation.
- Persist one required-nullable `targetHeadwaySeconds` on each route type; derived `serviceMetrics` is never save authority.
- Persisted non-null Bus and Metro targets below `60s` are invalid restore state and must be rejected using `SnapshotField::RouteTargetHeadway`.
- Direct schema/storage break to v8; no migration, fallback namespace, compatibility alias, or dual reader.
- Minimum target headway is `60s` for both modes; no arbitrary upper bound.
- Target headway is pre-deployment setup only; once any vehicle exists, do not edit the target in HPA-626.
- Required fleet is `max(1, ceil(roundTripSeconds / targetHeadwaySeconds))`.
- UI calls `roundTrip / assignedFleet` **Nominal headway**, never Current/Actual.
- Cycle math and deterministic placement use `current_path` and live `vehicle_step_seconds` only.
- Bus road steps remain congestion-aware; Metro track timing remains unaffected by `RoadFlow`.
- Initial deployment is one-shot, zero-fleet only, and atomic through existing `CostPolicy`.
- Keep existing low-level `AssignVehicle`; add no player plus-one vehicle control.
- Preserve existing structural route-edit rebase; do not resize/re-space after edits.
- Geometry-only Metro tests that lose the implicit train should expect `No fleet`; do not add `AssignVehicle` only to preserve an old `Running` assertion.
- Delete route-preview `initialVehicleCost` / `affordable` and route-only `WarningCode::InsufficientBudget` once Metro stops purchasing at create time.
- Preserve road-preview `RejectionCode::InsufficientBudget`; road/roundabout budget handling is outside HPA-626.
- TypeScript performs no service timing, congestion, required-fleet, or placement math.
- No service bands, closed periods, stop timetables, actual-departure history, holding/bunching, fleet top-up/withdrawal/reassignment, depots, maintenance, route visibility framework, or generic service-plan/scheduler abstraction.

## File structure

**Rename**

- `crates/caelum-core/src/bus_service.rs` -> `crates/caelum-core/src/service_control.rs` — shared Bus/Metro target validation, metrics, fleet math, placement, and deployment.
- `crates/caelum-core/tests/bus_service.rs` -> `crates/caelum-core/tests/service_control.rs` — preserve Bus regressions, including restore-floor coverage, and add Metro vectors.

**Modify — Rust core**

- `crates/caelum-core/src/model.rs` — v8; rename `BusServiceMetrics` to `ServiceMetrics`; add required target + serialize-only metrics to `MetroLine`.
- `crates/caelum-core/src/lib.rs` — register `service_control` instead of `bus_service`.
- `crates/caelum-core/src/engine.rs` — generic snapshot metric population and generic service intent dispatch; v8 documentation.
- `crates/caelum-core/src/intent.rs` — replace Bus-specific product intents with `SetServiceTargetHeadway` and `DeployInitialFleet`.
- `crates/caelum-core/src/route_editor.rs` — Task 1 adds the new Metro fields to the production `MetroLine` constructor without changing behavior; Task 3 removes Metro's implicit first vehicle/cost so both route types insert empty fleet.
- `crates/caelum-core/src/preview.rs` — delete now-dead route creation vehicle-affordability output and route-only budget warning path while preserving road-preview budget rejections.
- `crates/caelum-core/src/router.rs` — zero-fleet passenger gate for both Bus and Metro.
- `crates/caelum-core/src/persistence/entities.rs` — clear derived metrics from both route collections and apply the existing 60-second restore floor to Metro.
- `crates/caelum-core/src/transit.rs` — keep `vehicle_step_seconds`, `initial_vehicle`, `vehicle_cost`, and low-level `AssignVehicle` as shared seams.
- `crates/caelum-core/tests/model_wire_format.rs`, `route_preview.rs`, `transit_build.rs`, `transit_router.rs`, `economy_cost_policy.rs`, `golden_sequences.rs`, `route_editing.rs`, `shuttle_service.rs`, and Metro-dependent fixtures found by the explicit inventory in Task 3.

**Modify — TypeScript/UI/hosts**

- `src/domain/types.ts` — v8; generic `ServiceMetrics`; Metro target/metrics fields.
- `src/runtime/backend/types.ts` — raw Metro metrics/target; generic service intents; reduced `RoutePreviewResponse` and warning vocabulary.
- `src/runtime/snapshotView.ts` — normalize derived metrics/targets for both route collections.
- `src/runtime/types.ts` — generic runtime service methods and `ShellServiceState`.
- `src/runtime/createGameRuntime.ts` — dispatch mode-aware service intents.
- `src/runtime/runtimeSelectors.ts` — mode-neutral no-fleet/service-row presentation; remove route-draft affordability branch.
- `src/runtime/rejectionMessages.ts` — keep shared service-control rejection copy; remove only route-preview warning presentation that becomes unreachable.
- `src/components/hud/panels/LinesPanel.svelte`, `src/App.svelte`, `src/styles.css` — reuse the existing setup/display UI for both modes.
- `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs` — direct v8 namespaces.
- `docs/architecture.md` — active v8 persistence/service-control description.
- `tests/runtime/*`, `tests/ui/*`, `tests/e2e/routes.spec.ts`, and existing fixtures affected by the wire/preview/status changes.

---

### Task 1: Make the v8 Metro service wire/storage break and copy the restore invariant without changing creation behavior

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/engine.rs` documentation only
- Modify: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/src/route_editor.rs` only to initialize the new `MetroLine` fields; keep the implicit train in this task
- Modify: `crates/caelum-core/src/bus_service.rs` only for the `ServiceMetrics` type rename
- Modify: `crates/caelum-core/tests/bus_service.rs` — add Metro restore-floor regressions before the Task 2 rename
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: direct Rust `MetroLine { ... }` / `Route { ... }` fixtures found by compile
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts` raw snapshot types only
- Modify: `src/runtime/snapshotView.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: snapshot/persistence fixtures and tests
- Modify: `docs/architecture.md`

**Interfaces:**

Rust shared derived output:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub nominal_headway_seconds: Option<f64>,
}
```

Both line types expose:

```rust
#[serde(deserialize_with = "deserialize_required_option")]
pub target_headway_seconds: Option<u32>,

#[serde(
    skip_deserializing,
    default,
    skip_serializing_if = "Option::is_none"
)]
pub service_metrics: Option<ServiceMetrics>,
```

Task 1 does **not** remove Metro's implicit train yet. Product behavior stays green while the required Metro wire key/storage namespace and restore invariant move to v8.

- [ ] **Step 1: Write failing v8 and required-nullable Metro wire tests**

In `model_wire_format.rs`, extend the existing v7 Bus contract checks:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 8);

let metro_json = serde_json::to_value(&snapshot.transit.metro_lines[0]).unwrap();
assert!(metro_json.get("targetHeadwaySeconds").is_some());
assert_eq!(
    metro_json["targetHeadwaySeconds"],
    serde_json::Value::Null
);
```

Create one v8 Metro JSON value with `targetHeadwaySeconds` removed and assert deserialization fails. Create the same value with `targetHeadwaySeconds: null` and assert it succeeds.

Forge a non-null `serviceMetrics` object in incoming Metro JSON and assert:

```rust
assert_eq!(decoded.transit.metro_lines[0].service_metrics, None);
```

Keep the equivalent Bus assertions green under the renamed `ServiceMetrics` type.

- [ ] **Step 2: Write failing Metro restore-floor tests beside the existing Bus tests**

Copy the intent of `snapshot_restore_rejects_bus_headway_below_floor` and `snapshot_restore_accepts_bus_headway_at_floor`, but create a real Metro line fixture and mutate its target.

Below the floor:

```rust
let mut state = metro_route_engine().snapshot();
state.transit.metro_lines[0].target_headway_seconds = Some(59);
let error = GameEngine::from_snapshot(state).expect_err("sub-floor Metro headway must fail");
```

Assert the diagnostic contains:

```text
code = invalidNumericValue
context.entity.kind = metroLine
context.field = routeTargetHeadway
context.reason.kind = outOfRange
context.reason.details.minimum = 60
context.reason.details.actual = 59
```

At the floor:

```rust
let mut state = metro_route_engine().snapshot();
state.transit.metro_lines[0].target_headway_seconds = Some(60);
let restored = GameEngine::from_snapshot(state).expect("60-second Metro target loads");
assert_eq!(
    restored.snapshot().transit.metro_lines[0].target_headway_seconds,
    Some(60),
);
```

Do not add a Metro-specific `SnapshotField` or persistence error.

- [ ] **Step 3: Run the focused contract/restore tests and confirm the old v7 model fails**

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test bus_service snapshot_restore
```

Expected before implementation: schema/field assertions fail and the sub-floor Metro restore is incorrectly accepted.

- [ ] **Step 4: Update the Rust model and every production/direct literal**

Set:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 8;
```

Rename only the Rust type identifier:

```text
BusServiceMetrics -> ServiceMetrics
```

Add to every current `MetroLine` constructor/literal, including the production `insert_route` branch in `route_editor.rs`:

```rust
target_headway_seconds: None,
service_metrics: None,
```

Do not add a serde default to `target_headway_seconds`.

`Route` keeps the exact same wire keys/behavior and changes only its metrics type name. Keep Task 1's existing Metro first-vehicle quote/insertion untouched.

- [ ] **Step 5: Apply the existing restore floor to Metro and clear derived metrics for both collections**

Keep Bus validation unchanged. Immediately after the Metro `validate_route_shape` call, apply the same numeric rule:

```rust
if let Some(target) = line.target_headway_seconds {
    let floor = crate::bus_service::MIN_BUS_HEADWAY_SECONDS;
    if target < floor {
        return Err(PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::MetroLine, &line.id)),
            field: SnapshotField::RouteTargetHeadway,
            reason: NumericError::OutOfRange {
                minimum: f64::from(floor),
                maximum: f64::MAX,
                actual: f64::from(target),
            },
        });
    }
}
```

This deliberately points at the HPA-624 constant while the module still has its Bus name. Task 2 must retarget this reference to `service_control::MIN_HEADWAY_SECONDS` during the rename. Do not introduce a persistence-only constant or generic validation framework.

In the existing derived-field normalization path:

```rust
for route in &mut snapshot.transit.routes {
    route.service_metrics = None;
}
for line in &mut snapshot.transit.metro_lines {
    line.service_metrics = None;
}
```

Do not derive any metrics in persistence.

- [ ] **Step 6: Update canonical/raw TypeScript snapshot shapes**

In `src/domain/types.ts`:

```ts
export const SNAPSHOT_SCHEMA_VERSION = 8 as const;

export interface ServiceMetrics {
  roundTripSeconds: number;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}
```

Both `Route` and `MetroLine` use:

```ts
targetHeadwaySeconds: number | null;
serviceMetrics: ServiceMetrics | null;
```

Raw WASM/Tauri types allow serde omission/undefined only at the host boundary:

```ts
serviceMetrics?: ServiceMetrics | null;
targetHeadwaySeconds?: number | null;
```

Normalize both route collections to canonical nulls in `snapshotView.ts`:

```ts
serviceMetrics: line.serviceMetrics ?? null,
targetHeadwaySeconds: line.targetHeadwaySeconds ?? null,
```

No service math belongs in normalization.

- [ ] **Step 7: Move active storage namespaces directly to v8**

Use:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v8";
const DATABASE_VERSION = 8;
```

and:

```rust
const CITY_DIRECTORY: &str = "cities-v8";
```

Update current engine/backend comments and `docs/architecture.md` from v7 to v8.

Inventory active references:

```bash
rg -n 'schema[- ]?v?7|schema.?7|cities-v7|caelum-city-saves-v7|SNAPSHOT_SCHEMA_VERSION.?=.?7' \
  crates src src-tauri tests docs/architecture.md
```

Every match in those active paths must become v8. Historical `docs/superpowers/specs` and `docs/superpowers/plans` are intentionally excluded.

- [ ] **Step 8: Run contract/storage checks**

```bash
cargo test -p caelum-core --no-run
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test bus_service snapshot_restore
bun run check
bun run test:unit -- tests/runtime/snapshotView.test.ts tests/runtime/persistence/indexedDbCitySaveStore.test.ts
cargo test -p caelum_lib city_store
```

Expected: PASS with Metro creation behavior still unchanged and 59-second Metro targets rejected on restore.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core src src-tauri tests docs/architecture.md
git commit -m "feat: add metro service v8 contract"
```

---

### Task 2: Generalize HPA-624 service math/output into one Bus/Metro module

**Files:**
- Rename: `crates/caelum-core/src/bus_service.rs` -> `crates/caelum-core/src/service_control.rs`
- Rename: `crates/caelum-core/tests/bus_service.rs` -> `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs` — retarget the Bus/Metro restore-floor constant reference to the renamed shared module
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/transit.rs` only if visibility/import cleanup is required; do not duplicate timing
- Modify: `crates/caelum-core/tests/transit_router.rs`
- Modify: `crates/caelum-core/tests/persistence_snapshot.rs` if current output/save assertions are housed there

**Interfaces:**

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;

pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    mode: TransitMode,
    line_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot>;

pub(crate) fn deploy_initial_fleet(
    state: &GameSnapshot,
    mode: TransitMode,
    line_id: &str,
) -> GameplayResult<CostedMutation>;

pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot);
```

Private shared helpers:

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

fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize;
```

During Task 2, existing `SetBusTargetHeadway` / `DeployBusFleet` engine intents may continue to call these helpers with `TransitMode::Bus`. Product command names are changed atomically in Task 3.

- [ ] **Step 1: Preserve the Bus and new Metro restore regressions under the renamed test/module**

Use `git mv` rather than copy/delete:

```bash
git mv crates/caelum-core/src/bus_service.rs crates/caelum-core/src/service_control.rs
git mv crates/caelum-core/tests/bus_service.rs crates/caelum-core/tests/service_control.rs
```

Rename:

```rust
MIN_BUS_HEADWAY_SECONDS -> MIN_HEADWAY_SECONDS
```

Change imports/module registration from `bus_service` to `service_control`. In `persistence/entities.rs`, both Bus and Metro restore checks must end at:

```rust
let floor = crate::service_control::MIN_HEADWAY_SECONDS;
```

Do not change the restore assertions while renaming them into `service_control.rs`.

- [ ] **Step 2: Add failing Metro timing tests to `service_control.rs` tests**

Build Metro legs whose authoritative current track path totals 600 seconds while deliberately stale fields disagree:

```text
current_path total by live steps = 600s
last_valid_path                 = 777s
estimated_seconds               = 999s
```

Assert the shared helper returns 600 seconds.

Pass a `RoadFlow` containing heavy road flow at coincident points and assert the Metro value remains 600 seconds. This proves Metro uses `vehicle_step_seconds(TransitMode::Metro, ...)` rather than a copied congestion formula.

Keep the existing Bus 302s/402s shuttle vector unchanged.

- [ ] **Step 3: Add failing shared required/nominal/placement tests**

Lock the common formula:

```text
600 / 300 -> required 2
601 / 300 -> required 3
assigned 0 -> nominal None
600 / 2 assigned -> nominal 300
```

Add a Metro unequal-step path, for example:

```text
step A = 100s
step B = 300s
cycle  = 400s
fleet  = 2
vehicle 1 offset = 200s
```

The second vehicle must land 100 seconds into step B:

```rust
assert_eq!(cursor.path_step_index, 1);
assert!((cursor.step_progress - (100.0 / 300.0)).abs() < 1e-9);
```

- [ ] **Step 4: Run focused tests and confirm Bus-only code cannot satisfy Metro cases**

```bash
cargo test -p caelum-core --test service_control --test transit_router
```

Expected before implementation: Metro metric/placement/eligibility assertions fail; existing Bus/Metro restore-floor tests remain green after the rename.

- [ ] **Step 5: Generalize cycle and cursor walking over shared legs + mode**

Implement exactly one timing walk:

```rust
fn round_trip_seconds(
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
) -> Option<f64> {
    let mut total = 0.0;
    for leg in legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            let seconds = crate::transit::vehicle_step_seconds(flow, mode, step);
            if seconds > 0.0 {
                total += seconds;
            }
        }
    }
    (total.is_finite() && total > 0.0).then_some(total)
}
```

Make `resolve_service_cursor` consume the same `legs`, `mode`, `flow` tuple. Do not branch into separate Bus/Metro walkers.

- [ ] **Step 6: Generalize line lookup without a trait hierarchy**

Keep two explicit branches inside `service_control`:

```rust
match mode {
    TransitMode::Bus => { /* find Route */ }
    TransitMode::Metro => { /* find MetroLine */ }
    TransitMode::Walk => return Err(/* existing incompatible-route rejection */),
}
```

Both branches feed the same private helpers with `legs`, target, and `vehicle_ids`.

Use existing `vehicle_cost(mode)` / `initial_vehicle(state, mode, line_id)` rather than adding a cost strategy object.

- [ ] **Step 7: Populate derived metrics for both route collections**

Derive `RoadFlow` once:

```rust
pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot) {
    let flow = crate::traffic::derive_road_flow(snapshot);
    // fill snapshot.transit.routes
    // fill snapshot.transit.metro_lines
}
```

Each output object receives:

```rust
ServiceMetrics {
    round_trip_seconds,
    assigned_fleet,
    required_fleet,
    nominal_headway_seconds,
}
```

`GameEngine::snapshot()` calls only `service_control::populate_snapshot_metrics`.

- [ ] **Step 8: Make passenger eligibility mode-neutral**

Keep `is_route_operational` structural, but in `router::active_services` require non-empty `vehicle_ids` for Bus **and** Metro.

Add assertions:

```text
active connected Metro + zero vehicles -> not routable
same Metro + one low-level AssignVehicle -> routable
```

Bus zero-fleet and one-vehicle regressions remain unchanged.

- [ ] **Step 9: Prove output metrics are not save authority**

Assert `engine.snapshot()` contains derived service metrics on both current Bus and Metro lines, while:

```rust
let save = engine.snapshot_for_save();
assert!(save.transit.routes.iter().all(|r| r.service_metrics.is_none()));
assert!(save.transit.metro_lines.iter().all(|l| l.service_metrics.is_none()));
```

- [ ] **Step 10: Run the focused + compile suite**

```bash
cargo fmt --check
cargo test -p caelum-core --test service_control --test transit_router --test persistence_snapshot
cargo test -p caelum-core --no-run
```

Expected: PASS. Metro creation still owns its initial train until Task 3, and both restore-floor checks now use `service_control::MIN_HEADWAY_SECONDS`.

- [ ] **Step 11: Commit**

```bash
git add crates/caelum-core
git commit -m "refactor: share transit service control math"
```

---

### Task 3: Add mode-aware service commands, make Metro creation fleet-free, delete route-preview vehicle affordability, and inventory status retargets

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/route_preview.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/golden_sequences.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/shuttle_service.rs`
- Modify: all Metro fixtures identified by the inventory step below
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts` runtime command names only
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts` route-preview affordability branch only
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/LinesPanel.svelte` callback names only; Metro rendering stays Task 4
- Modify: runtime/backend/UI tests that compile against the command/preview wire

**Interfaces:**

Rust replaces the Bus-specific product intents:

```rust
SetServiceTargetHeadway {
    mode: TransitMode,
    line_id: String,
    target_headway_seconds: u32,
},
DeployInitialFleet {
    mode: TransitMode,
    line_id: String,
},
```

TypeScript:

```ts
| {
    type: "setServiceTargetHeadway";
    mode: "bus" | "metro";
    lineId: string;
    targetHeadwaySeconds: number;
  }
| {
    type: "deployInitialFleet";
    mode: "bus" | "metro";
    lineId: string;
  }
```

Runtime controller:

```ts
setServiceTargetHeadway(
  mode: "bus" | "metro",
  lineId: string,
  targetHeadwaySeconds: number,
): RuntimeCommandResult;

deployInitialFleet(
  mode: "bus" | "metro",
  lineId: string,
): RuntimeCommandResult;
```

Route preview becomes geometry-only:

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

- [ ] **Step 1: Inventory every Metro fixture, status assertion, and obsolete preview-cost assertion before changing creation**

Run the service/preview inventory:

```bash
rg -n 'TransitMode::Metro|mode: "metro"|mode: TransitMode::Metro|METRO_COST|initial_vehicle_cost|initialVehicleCost|\.affordable|WarningCode::InsufficientBudget|SetBusTargetHeadway|DeployBusFleet|setBusTargetHeadway|deployBusFleet' \
  crates/caelum-core src tests
```

Then explicitly inventory Metro UI/status assumptions that can be wrong once the implicit train disappears:

```bash
rg -n 'primary: "running"|toHaveText\([[:space:]]*"Running"|route-status-|busService: null|vehicleIds: \[\]' \
  tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/e2e/routes.spec.ts tests/helpers/gameState.ts
```

Classify each match using these exact rules:

```text
Metro test needs moving/routable service -> add explicit AssignVehicle or use target+deploy when service-control behavior is under test
Metro test only needs route geometry/repair -> keep zero fleet; expected service status becomes No fleet once Task 4 makes status mode-neutral
Metro status currently says Running only because CreateRoute inserted a train -> retarget the assertion; do not add a train to preserve the old label
route-preview vehicle-cost assertion -> delete/replace with geometry-only assertion
Bus product command -> rename to generic command with mode=Bus
```

Known retargets to keep visible in the inventory:

- `tests/runtime/runtimeSelectors.test.ts`: the existing empty-fleet Metro row currently expects `running` and `busService: null`; Task 4 must change it to `noFleet` plus generic service state.
- `tests/ui/linesPanel.test.ts`: the existing Metro row currently asserts no service block; Task 4 must move it onto the shared service shape/markup.
- `tests/e2e/routes.spec.ts`: the station-rebuild geometry flow currently expects `Running` after repair because creation supplied the implicit train; Task 5 must expect `No fleet` unless that test explicitly deploys service (it should not).

Do not preserve old product intent aliases.

- [ ] **Step 2: Write failing Metro creation/deployment/cost tests**

Add assertions equivalent to:

```rust
let created = engine.dispatch(GameIntent::CreateRoute {
    mode: TransitMode::Metro,
    pattern: ServicePattern::Loop,
    waypoint_ids: station_ids,
});
assert!(created.applied);
assert!(created.snapshot.transit.metro_lines[0].vehicle_ids.is_empty());
assert!(created.snapshot.transit.vehicles.is_empty());
assert_eq!(created.snapshot.budget, budget_before);
```

Then set a target and deploy through the new generic intents:

```rust
GameIntent::SetServiceTargetHeadway {
    mode: TransitMode::Metro,
    line_id: "metro-001".into(),
    target_headway_seconds: 300,
}

GameIntent::DeployInitialFleet {
    mode: TransitMode::Metro,
    line_id: "metro-001".into(),
}
```

Assert assigned fleet equals Rust-derived required fleet.

- [ ] **Step 3: Add Standard/Creative atomic Metro fleet-cost tests**

For a fixture requiring `N` trains, Standard must satisfy:

```rust
assert_eq!(after.budget, before.budget - i32::try_from(N).unwrap() * METRO_COST);
```

With one dollar less than the complete quote, assert deployment rejects and the snapshot has **zero** trains assigned/inserted.

Creative uses the same target/required fleet but leaves budget unchanged.

Keep existing Bus cost tests green.

- [ ] **Step 4: Run focused tests and confirm old implicit Metro behavior fails the new expectations**

```bash
cargo test -p caelum-core --test service_control --test transit_build --test economy_cost_policy --test route_preview
```

Expected before implementation: Metro creation/cost/intent and preview-shape assertions fail.

- [ ] **Step 5: Replace Bus-specific product intent dispatch with the generic pair**

In `engine.rs`:

```rust
GameIntent::SetServiceTargetHeadway {
    mode,
    line_id,
    target_headway_seconds,
} => self.commit_result(
    service_control::set_target_headway(
        &self.snapshot,
        mode,
        &line_id,
        target_headway_seconds,
    )
    .map(CostedMutation::free),
),

GameIntent::DeployInitialFleet { mode, line_id } => self.commit_result(
    service_control::deploy_initial_fleet(&self.snapshot, mode, &line_id),
),
```

Delete `SetBusTargetHeadway` and `DeployBusFleet`. No compatibility variants.

- [ ] **Step 6: Make `create_route_costed` fleet-free for both modes**

Delete the Metro-only initial vehicle quote/insertion branch. Route creation should now authorize no vehicle purchase and insert:

```rust
vehicle_ids: Vec::new(),
```

for both `Route` and `MetroLine`.

The Metro constructor already owns the Task 1 fields:

```rust
target_headway_seconds: None,
service_metrics: None,
```

Do not remove low-level `transit::assign_vehicle_costed`.

- [ ] **Step 7: Delete route-preview vehicle affordability instead of returning permanent zeroes**

From Rust route preview remove:

```text
initial_vehicle_cost
affordable
route CostPolicy quote
WarningCode::InsufficientBudget
route-preview insufficient-budget warning injection
```

Delete the Metro-specific cost tests in `route_preview.rs` and replace them with one explicit regression:

```rust
let mut engine = editable_metro_network_engine();
engine.set_budget_for_test(0);
let response = engine.preview_route(valid_metro_route_preview(31));
assert!(response.rejection.is_none());
assert!(!response.legs.is_empty());
```

This proves route geometry preview no longer depends on fleet-purchase budget.

Do **not** delete or bypass ordinary `RejectionCode::InsufficientBudget` handling. `rejected_road_preview` still uses it to surface attempted road/roundabout cost.

- [ ] **Step 8: Update TypeScript wire/runtime command names in the same task**

Change `GameIntent` and runtime controller methods to the generic pair. `createGameRuntime.ts` dispatches only the supplied mode/line/target; no calculations.

Rename the existing LinesPanel callbacks without widening its render condition yet:

```ts
onSetServiceTargetHeadway: (
  mode: "bus" | "metro",
  lineId: string,
  targetHeadwaySeconds: number,
) => void;

onDeployInitialFleet: (
  mode: "bus" | "metro",
  lineId: string,
) => void;
```

The existing Bus setup branch calls them with `route.mode`, which is `"bus"` there. This keeps Bus UI behavior green while Task 4 adds Metro rendering.

- [ ] **Step 9: Remove TypeScript route-draft affordability presentation**

Reduce `RoutePreviewResponse` in `backend/types.ts` to the Rust geometry-only shape and remove the route-preview-only `"insufficientBudget"` warning member if it is still represented there.

Delete from `routeDraftPreviewMessage`:

```ts
if (!preview.affordable) {
  return {
    status: "rejected",
    message: `Need ${formatBudget(preview.initialVehicleCost)}.`,
  };
}
```

Do not replace it with a fake zero-cost check.

Update route-preview fixtures/tests so no object contains `initialVehicleCost` or `affordable`. Keep ordinary gameplay `insufficientBudget` rejection handling elsewhere unchanged.

- [ ] **Step 10: Migrate Metro fixtures that truly require live service; record geometry-only status retargets for Tasks 4/5**

For tests unrelated to headway/deployment that genuinely require a moving/routable train, keep the simplest existing low-level seam:

```rust
let assigned = engine.dispatch(GameIntent::AssignVehicle {
    mode: "metro".to_string(),
    line_id: "metro-001".to_string(),
});
assert!(assigned.applied, "fixture train should apply: {assigned:?}");
```

Use target+deploy only in HPA-626 service-control tests.

For UI/E2E cases whose subject is route geometry, repair, or selection, **do not** add `AssignVehicle`. Keep the route zero-fleet and retarget their `Running`/no-service expectations in Task 4 or Task 5 when the mode-neutral presentation lands.

- [ ] **Step 11: Preserve deterministic deployment across simulation granularity**

Extend `golden_sequences.rs` with a deployed Metro line and compare the same elapsed simulated time under coarse vs fine ticks. Assert equivalent vehicle cursors/snapshot state using the repository's existing granularity comparison pattern.

Do not add a new benchmark harness.

- [ ] **Step 12: Run the full core suite plus wire/runtime checks before committing**

```bash
cargo test -p caelum-core
bun run test:unit -- tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
```

Expected: Bus startup remains green; Metro is fleet-free and deployable; old preview affordability is gone. Metro UI may still show its pre-Task-4 presentation, but no test should have been patched with an artificial train solely to preserve `Running`.

- [ ] **Step 13: Commit**

```bash
git add crates/caelum-core src tests
git commit -m "feat: add metro initial fleet deployment"
```

---

### Task 4: Reuse one service presentation and Lines-row setup flow for Bus and Metro

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css` only if the existing route-service styles require a mode-neutral selector/name
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts` for mode-aware dispatch assertions

**Interfaces:**

```ts
export interface ShellServiceState {
  targetHeadwaySeconds: number | null;
  roundTripSeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}

export interface ShellRouteListItem {
  // existing fields
  mode: "bus" | "metro";
  status: RouteServiceStatus;
  service: ShellServiceState;
}
```

Status remains:

```ts
primary: "running" | "paused" | "broken" | "noFleet";
```

- [ ] **Step 1: Write failing selector tests and retarget the existing empty-fleet Metro assertion**

Construct canonical Bus and Metro rows with identical derived service values and assert both select:

```ts
{
  targetHeadwaySeconds: 360,
  roundTripSeconds: 700,
  assignedFleet: 0,
  requiredFleet: 2,
  nominalHeadwaySeconds: null,
}
```

The existing `addTestMetroLine` helper already produces `vehicleIds: []`. Update the current selector expectation from:

```ts
status: { primary: "running", pausedAfterRepair: false },
busService: null,
```

to the new zero-fleet model:

```ts
status: { primary: "noFleet", pausedAfterRepair: false },
service: {
  targetHeadwaySeconds: null,
  roundTripSeconds: null,
  assignedFleet: 0,
  requiredFleet: null,
  nominalHeadwaySeconds: null,
},
```

Do not add a vehicle to this fixture: this test is selecting shell state, not proving live train movement.

After adding two vehicle IDs and a Rust-derived nominal headway in a separate service-present fixture, assert `running` and `nominalHeadwaySeconds` unchanged from the snapshot.

- [ ] **Step 2: Write failing LinesPanel tests for Metro setup/deployed display and remove the old no-service-block assumption**

The existing Metro row test currently asserts:

```ts
expect(screen.queryByTestId("route-service-line-metro-001")).toBeNull();
```

That assertion becomes obsolete when every supported line has `service`. Replace it with explicit Metro coverage.

Before deployment assert the Metro row renders:

```text
No fleet
Target
Required
trains
Set
Deploy fleet
```

After deployment assert:

```text
Target
Nominal
Fleet
```

and no headway input / Set / Deploy button.

Keep the existing Bus assertions and use `buses` for its required count. Broken/paused precedence remains independent from whether the shared service block exists.

- [ ] **Step 3: Run focused selector/UI tests and confirm Metro currently lacks service state**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Expected before implementation: Metro no-fleet/service-row assertions fail.

- [ ] **Step 4: Replace Bus-specific shell presentation names**

Rename:

```text
ShellBusServiceState -> ShellServiceState
busService           -> service
selectBusServiceState -> selectServiceState
```

`selectServiceState` accepts either `Route` or `MetroLine` and only passes through authority:

```ts
function selectServiceState(route: Route | MetroLine): ShellServiceState {
  return {
    targetHeadwaySeconds: route.targetHeadwaySeconds,
    roundTripSeconds: route.serviceMetrics?.roundTripSeconds ?? null,
    assignedFleet: route.vehicleIds.length,
    requiredFleet: route.serviceMetrics?.requiredFleet ?? null,
    nominalHeadwaySeconds: route.serviceMetrics?.nominalHeadwaySeconds ?? null,
  };
}
```

No formula is allowed here.

- [ ] **Step 5: Make no-fleet status mode-neutral**

Keep precedence exactly:

```ts
if (route.pathBroken) return { primary: "broken", ... };
if (!route.active) return { primary: "paused", ... };
if (route.vehicleIds.length === 0) return { primary: "noFleet", ... };
return { primary: "running", ... };
```

Do not add a persisted service status.

- [ ] **Step 6: Reuse the existing Lines setup markup for both modes**

Remove the Bus-only render condition. Use `route.service` for both.

The only mode-specific copy is the required-fleet noun:

```ts
function fleetNoun(mode: "bus" | "metro", count: number): string {
  if (mode === "bus") return count === 1 ? "bus" : "buses";
  return count === 1 ? "train" : "trains";
}
```

The button remains exactly:

```text
Deploy fleet
```

and dispatches:

```ts
onDeployInitialFleet(route.mode, route.id)
```

Set dispatches:

```ts
onSetServiceTargetHeadway(route.mode, route.id, minutes * 60)
```

Keep `min="1"`, integer minutes, and the existing Rust-u32 overflow guard. Rust remains authoritative.

- [ ] **Step 7: Keep post-deployment UI read-only**

For any line where `assignedFleet > 0`, show only:

```text
Target
Nominal
Fleet
```

Do not show Required, input, Set, Deploy, plus/minus fleet controls, or target mismatch actions.

- [ ] **Step 8: Verify runtime dispatch includes mode and no local math**

In `gameRuntime.test.ts`, assert Bus and Metro calls generate:

```ts
{
  type: "setServiceTargetHeadway",
  mode: "metro",
  lineId: "metro-001",
  targetHeadwaySeconds: 360,
}
```

and:

```ts
{
  type: "deployInitialFleet",
  mode: "metro",
  lineId: "metro-001",
}
```

Do not assert any TypeScript-derived fleet count/cost.

- [ ] **Step 9: Run UI/runtime quality checks**

```bash
bun run test:unit -- tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
```

Expected: PASS for both route modes, with empty-fleet Metro represented as `No fleet` rather than `Running`.

- [ ] **Step 10: Commit**

```bash
git add src tests/runtime tests/ui
git commit -m "feat: configure metro service from lines panel"
```

---

### Task 5: Prove the real Metro setup loop, retarget the geometry E2E, and run full regression verification

**Files:**
- Modify: `tests/e2e/routes.spec.ts`
- Modify other files only for concrete regressions exposed by the verification commands below

**Interfaces:**
- Verifies the browser/WASM player composition using the same Svelte runtime and Rust rules used by the desktop host.
- Owns final regression proof, not new product features.

- [ ] **Step 1: Retarget the existing Metro repair E2E to the zero-fleet model**

Reuse the existing station-rebuild flow in `routes.spec.ts`. It is a geometry/repair test, not a service-start test.

After the broken station is rebuilt, change the old expectation:

```text
Running
```

to:

```text
No fleet
```

because the repaired line is active + connected + zero-fleet after HPA-626. Do not add `AssignVehicle` or deploy service just to preserve the old label.

Also update the stale budget comment in that flow: route creation no longer spends `METRO_COST`, so describe only the costs the test actually incurs.

- [ ] **Step 2: Add one real Metro Target -> Deploy E2E using the existing Metro layout/build helpers**

Reuse the same Metro track/station construction helpers/patterns already present in `routes.spec.ts`; do not create a second E2E abstraction.

The test sequence is exactly:

```text
open/create sandbox
lay connected track
place two Metro stations
create/save Metro line
assert row says No fleet
assert runtime Metro line has zero vehicleIds
enter a whole-minute target and click Set
assert Required <N> trains is visible
click Deploy fleet
assert runtime Metro line has non-empty vehicleIds
assert row shows Target, Nominal, Fleet and hides setup controls
Resume
assert simulation clock advances
```

Do not click Deploy until the `No fleet` state and zero `vehicleIds` are observed. Do not wait for commuters, inspect train pixels, or reproduce metric formulas in Playwright. Rust tests own timing/placement correctness.

- [ ] **Step 3: Run focused route E2E**

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Expected: the geometry repair ends at `No fleet`, existing Bus setup coverage stays green, and the new Metro Set -> Deploy flow passes.

- [ ] **Step 4: Run complete Rust/TypeScript/build-quality verification**

```bash
cargo test --workspace
bun run test:unit
bun run check
bun run format:check
bun run lint
```

Expected: all pass.

- [ ] **Step 5: Run the full E2E suite once**

```bash
bun run test:e2e
```

Expected: existing route editing, persistence, traffic, Bus startup, Metro startup, and sandbox creation flows pass.

- [ ] **Step 6: Verify the direct v8 break has no active v7 leftovers**

```bash
rg -n 'schema[- ]?v?7|schema.?7|cities-v7|caelum-city-saves-v7|SNAPSHOT_SCHEMA_VERSION.?=.?7' \
  crates src src-tauri tests docs/architecture.md
```

Expected: no active matches. Historical specs/plans are intentionally outside this inventory.

- [ ] **Step 7: Verify old Bus-only product/public names are gone**

```bash
rg -n 'BusServiceMetrics|busService|ShellBusServiceState|SetBusTargetHeadway|DeployBusFleet|setBusTargetHeadway|deployBusFleet' \
  crates src src-tauri tests
```

Expected: no active implementation/test matches. Historical docs are excluded.

- [ ] **Step 8: Verify dead route-preview vehicle affordability is gone without scanning road budget rejections**

Use the narrow Rust scan:

```bash
rg -n 'initial_vehicle_cost|WarningCode::InsufficientBudget' \
  crates/caelum-core/src/preview.rs crates/caelum-core/tests/route_preview.rs
```

Use the narrow TypeScript/presentation scan:

```bash
rg -n 'initialVehicleCost|\.affordable' \
  src/runtime/backend/types.ts src/runtime/runtimeSelectors.ts tests/runtime tests/ui
```

Expected: no matches.

Do **not** grep generic `InsufficientBudget` as a cleanup condition. `RejectionCode::InsufficientBudget` is still intentionally used by road-mutation preview and ordinary gameplay budget handling.

- [ ] **Step 9: Verify the shared restore floor survived the module rename**

```bash
rg -n 'MIN_BUS_HEADWAY_SECONDS|service_control::MIN_HEADWAY_SECONDS|RouteTargetHeadway' \
  crates/caelum-core/src/persistence/entities.rs crates/caelum-core/tests/service_control.rs
```

Expected:

```text
no MIN_BUS_HEADWAY_SECONDS references
Bus and Metro validation reference service_control::MIN_HEADWAY_SECONDS
Bus and Metro restore tests cover RouteTargetHeadway at 59/60 seconds
```

- [ ] **Step 10: Verify scope stayed lean**

Final diff must not introduce any of these concepts/files:

```text
ServicePlan persistence object
service-period/band collection
timetable/schedule engine
departure history or actual-headway metric
post-deployment target editing
fleet top-up/withdrawal/reassignment
auto resize/re-spacing
holding/bunching logic
depot/crew/maintenance model
route trait hierarchy or fleet repository/manager
TypeScript timing/congestion/fleet-count formula
route visibility/map-layer framework
save migration/fallback reader
player-facing AssignVehicle plus-one control
```

It must still preserve:

```text
existing structural route-edit rebase
existing low-level AssignVehicle support
Bus congestion-aware cycle timing
Metro fixed track timing
one-shot atomic CostPolicy deployment
road-preview RejectionCode::InsufficientBudget behavior
```

- [ ] **Step 11: Commit E2E/final regression fixes**

```bash
git add tests/e2e/routes.spec.ts
git commit -m "test: cover metro service startup loop"
```

## Plan self-review

- **Spec coverage:** Every HPA-626 acceptance item maps to Tasks 1–5: v8 authority/storage and Metro restore floor, shared Rust timing/output, Metro zero-fleet creation/deployment/cost/routing, dead preview cleanup, shared UI, and real composition proof.
- **Restore invariant:** The existing Bus 60-second persisted-target floor is copied to Metro in Task 1 with `EntityKind::MetroLine` + `SnapshotField::RouteTargetHeadway`, then retargeted to `service_control::MIN_HEADWAY_SECONDS` in Task 2. No new persistence concept is added.
- **Second-consumer rule:** Only HPA-624 seams with two concrete consumers are generalized. No `ServicePlan`, scheduler, trait hierarchy, or fleet manager is added.
- **Authority:** Rust alone owns current cycle time, required fleet, deployment count/cost, passenger eligibility, deterministic cursor placement, and persisted-target validity. TypeScript only normalizes, formats, and dispatches.
- **Creation consistency:** The implicit Metro train is removed only in Task 3 alongside the replacement mode-aware Set -> Deploy command path and the Metro fixture inventory; there is no knowingly red intermediate product state.
- **Status retargeting:** Empty-fleet Metro geometry/repair tests become `No fleet`; `AssignVehicle` is reserved for tests that actually require live/routable service rather than being used to hide the new product model.
- **Preview cleanup:** `initialVehicleCost` / `affordable` and route-only `WarningCode::InsufficientBudget` are deleted when their last real consumer disappears. Final scans deliberately do not target ordinary `RejectionCode::InsufficientBudget`, preserving road-preview budget behavior.
- **Bus regression:** Existing HPA-624 Bus vectors, deployment rules, restore floor, and Lines flow remain first-class tests through the generalization.
- **Metro behavior:** Metro timing uses the same `vehicle_step_seconds` seam; `RoadFlow` has no effect on Metro because track-step timing already ignores it.
- **YAGNI/KISS:** No post-deployment fleet management, service bands, actual-headway history, holding/bunching, route visibility framework, compatibility path, or new infrastructure layer enters HPA-626.