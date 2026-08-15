# HPA-624 Bus Headway and Initial Fleet Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate bus route geometry from service startup: persist one pre-deployment target headway, derive all service/fleet numbers in Rust, make new bus routes fleet-free only when the replacement deployment flow exists, and let the existing Lines panel deploy one deterministically spaced initial fleet.

**Architecture:** `caelum-core` remains authoritative. A small `bus_service` module reuses live `vehicle_step_seconds` to derive cycle time, required fleet, nominal headway, and deterministic placement. `GameEngine::snapshot()` exposes these numbers as serialize-only derived route output; persistence clears/ignores them. TypeScript only normalizes/formats the Rust values and dispatches two intents. Metro creation remains unchanged and no general service-plan/fleet framework is introduced.

**Tech Stack:** Rust (`caelum-core`, serde), Svelte 5 + TypeScript, existing WASM/Tauri `GameBackend.dispatch`, Vitest, Playwright, Bun, IndexedDB/native Tauri persistence.

## Global Constraints

- HPA-624 only; HPA-334 remains the coordination parent.
- Bus-only service controls; Metro headway/service-plan behavior stays unchanged.
- Persist only `Route.targetHeadwaySeconds`; service metrics are derived output and never trusted from saves.
- Direct schema/storage break to v7; no migration or compatibility reader.
- Minimum target headway is `60s`; no upper bound in this slice.
- Headway is a **pre-deployment setup control**; once any bus exists, do not edit target in HPA-624.
- Required fleet is `max(1, ceil(roundTripSeconds / targetHeadwaySeconds))`.
- UI calls `roundTrip / assignedFleet` **Nominal headway**, never Current/Actual.
- Cycle math and placement use live `vehicle_step_seconds` over `current_path` only.
- Initial deployment is one-shot, zero-fleet only, and atomic under `CostPolicy`.
- Keep existing low-level `AssignVehicle`; add no player plus-one control.
- Preserve structural route-edit rebase; do not re-space/resize after edits.
- No TypeScript congestion/service timing implementation.
- No service bands, timetable/departure history, top-up/withdrawal/reassignment, holding/bunching, depots, fleet inventory, or generic scheduler/fleet/service-plan abstraction.

## File structure

**Create**

- `crates/caelum-core/src/bus_service.rs` — Rust-only cycle/fleet math, target validation, derived metrics population, and initial fleet placement.
- `crates/caelum-core/tests/bus_service.rs` — focused service-math/deployment tests.

**Modify — Rust core**

- `crates/caelum-core/src/model.rs` — v7, required target field, serialize-only derived `BusServiceMetrics`.
- `crates/caelum-core/src/lib.rs` — register `bus_service`.
- `crates/caelum-core/src/transit.rs` — expose existing `vehicle_step_seconds`; keep `AssignVehicle` unchanged.
- `crates/caelum-core/src/router.rs` — zero-fleet bus passenger gate.
- `crates/caelum-core/src/engine.rs` — derived snapshot output + new intent dispatch; v7 comment.
- `crates/caelum-core/src/persistence/entities.rs` — clear derived service metrics during normalization.
- `crates/caelum-core/src/route_editor.rs` — fleet-free bus creation in Task 3 only.
- `crates/caelum-core/src/preview.rs` — bus creation preview cost becomes zero in Task 3.
- `crates/caelum-core/src/intent.rs` — `SetBusTargetHeadway`, `DeployBusFleet`.
- `crates/caelum-core/src/rejection.rs` — `InvalidHeadway`, `HeadwayNotSet`, `FleetAlreadyAssigned`.
- `crates/caelum-core/tests/model_wire_format.rs`, `route_editing.rs`, `transit_router.rs`, `economy_cost_policy.rs`, `golden_sequences.rs`, `shuttle_service.rs`, `route_resilience.rs`, and all bus-service fixtures discovered by the Task 3 inventory.

**Modify — TypeScript/UI/hosts**

- `src/domain/types.ts` — v7 target + canonical derived service-metrics types/rejection codes.
- `src/runtime/backend/types.ts` — raw Rust route metrics + two intent variants.
- `src/runtime/snapshotView.ts` — normalize missing/undefined derived metrics to `null`.
- `src/runtime/types.ts` — route-row service display + runtime controller methods.
- `src/runtime/createGameRuntime.ts` — dispatch existing backend intents.
- `src/runtime/runtimeSelectors.ts` — read Rust metrics; `noFleet` status; no timing math.
- `src/runtime/rejectionMessages.ts` — service-control rejection copy.
- `src/components/hud/panels/LinesPanel.svelte`, `src/App.svelte`, `src/styles.css` — compact setup/display UI.
- `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs` — v7 namespaces.
- `docs/architecture.md` — active v7 host/persistence description.
- `tests/fixtures/rustSnapshot.ts`, runtime/UI/persistence tests, and `tests/e2e/routes.spec.ts`.

---

### Task 1: Make the v7 wire/storage break without changing bus creation behavior

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/engine.rs` documentation only
- Modify: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: direct Rust `Route { ... }` fixtures reported by compile
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts` schema/raw-route types
- Modify: `src/runtime/snapshotView.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify: persistence/snapshot-view tests
- Modify: `docs/architecture.md`

**Interfaces:**

Rust persisted target:

```rust
#[serde(deserialize_with = "deserialize_required_option")]
pub target_headway_seconds: Option<u32>,
```

Rust derived runtime output placeholder:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub nominal_headway_seconds: Option<f64>,
}

#[serde(
    skip_deserializing,
    default,
    skip_serializing_if = "Option::is_none"
)]
pub service_metrics: Option<BusServiceMetrics>,
```

Task 1 does **not** populate metrics yet and does **not** remove the implicit first bus. Existing gameplay stays green while the wire/storage contract moves to v7.

- [ ] **Step 1: Write failing v7/required-nullable tests**

Add assertions equivalent to:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 7);

let route_json = serde_json::to_value(&snapshot.transit.routes[0]).unwrap();
assert!(route_json.get("targetHeadwaySeconds").is_some());
assert_eq!(route_json["targetHeadwaySeconds"], serde_json::Value::Null);
```

Deserialize a v7 route with the target key omitted and assert it fails. Deserialize one with `targetHeadwaySeconds: null` and assert it succeeds.

For `serviceMetrics`, prove incoming JSON cannot become authority: provide a forged object and assert the deserialized route has `service_metrics == None`.

- [ ] **Step 2: Run focused tests to prove the old schema fails**

```bash
cargo test -p caelum-core --test model_wire_format
```

Expected before implementation: v6/schema/field assertions fail.

- [ ] **Step 3: Add the v7 model fields and explicit fixture values**

Set:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 7;
```

Every engine/test-created bus `Route` literal gets:

```rust
target_headway_seconds: None,
service_metrics: None,
```

Do not add a serde default to `target_headway_seconds`.

Canonical TS shape:

```ts
export const SNAPSHOT_SCHEMA_VERSION = 7 as const;

export interface BusServiceMetrics {
  roundTripSeconds: number;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}

export interface Route {
  // existing fields
  targetHeadwaySeconds: number | null;
  serviceMetrics: BusServiceMetrics | null;
}
```

Raw Rust route type may declare `serviceMetrics?: BusServiceMetrics | null` because serde may omit `None`.

- [ ] **Step 4: Make persistence explicitly discard derived service metrics**

In the existing entity derived-state normalization path, clear:

```rust
for route in &mut snapshot.transit.routes {
    route.service_metrics = None;
}
```

This protects direct Rust `GameSnapshot` restore in addition to serde's `skip_deserializing` behavior. Do not calculate service metrics in persistence.

`normalizeRustSnapshot` canonicalizes runtime output:

```ts
routes: snapshot.transit.routes.map((route) => ({
  ...route,
  serviceMetrics: route.serviceMetrics ?? null,
  legs: route.legs.map(normalizeRouteLegPath),
})),
```

- [ ] **Step 5: Update storage namespaces and every active v6 assertion**

Use:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v7";
const DATABASE_VERSION = 7;
```

```rust
const CITY_DIRECTORY: &str = "cities-v7";
```

Inventory current code/tests/docs:

```bash
rg -n 'schema[- ]?v?6|schema.?6|cities-v6|caelum-city-saves-v6|SNAPSHOT_SCHEMA_VERSION.?=.?6' \
  crates src src-tauri tests docs/architecture.md
```

Update active references including `GameEngine::from_snapshot`, backend comments, fixtures, IndexedDB/native tests, and architecture. Do not rewrite historical specs/plans.

- [ ] **Step 6: Compile every Route literal and run contract checks**

```bash
cargo test -p caelum-core --no-run
bun run check
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/snapshotView.test.ts tests/runtime/persistence/indexedDbCitySaveStore.test.ts
cargo test -p caelum_lib city_store
```

If the targeted Tauri package/test spelling differs, use the repository's existing `city_store` test invocation. Fix only current v7/field fallout.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core src src-tauri tests docs/architecture.md
git commit -m "feat: add bus headway v7 contract"
```

---

### Task 2: Derive bus service metrics in Rust and publish them through snapshots

**Files:**
- Create: `crates/caelum-core/src/bus_service.rs`
- Create: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`
- Modify: `crates/caelum-core/tests/shuttle_service.rs` only if an existing fixture is the cleanest real reversal source

**Interfaces:**

```rust
pub const MIN_BUS_HEADWAY_SECONDS: u32 = 60;

pub(crate) fn metrics(route: &Route, flow: &RoadFlow) -> Option<BusServiceMetrics>;
pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize;
pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot);
```

Reuse the existing helper, made crate-visible without changing behavior:

```rust
pub(crate) fn vehicle_step_seconds(
    flow: &RoadFlow,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64;
```

- [ ] **Step 1: Write failing formula/current-path tests**

Lock:

```text
600s cycle, target 300s -> required 2
601s cycle, target 300s -> required 3
target unset -> required None
assigned 0 -> nominal None
600s / 2 assigned -> nominal 300s
```

Build a route whose `estimated_seconds` and `last_valid_path` deliberately disagree with `current_path`; assert metrics use `current_path` only.

- [ ] **Step 2: Add explicit shuttle reversal vectors**

Use current-path legs:

```text
outbound service  100s
empty reversal      0s
return service    200s
U-turn reversal      2s
cycle              302s
```

Assert `302s` at free flow. Set flow `8` on the outbound point (existing capacity `4`) and assert `402s`.

This locks empty-reversal skip behavior and timed U-turn behavior without a shuttle-specific algorithm.

- [ ] **Step 3: Add zero-fleet passenger eligibility tests**

Construct an active connected bus route with `vehicle_ids = []` and assert passenger planning does not return it.

Then use the existing low-level `AssignVehicle` seam once and assert the same route becomes eligible. This proves `AssignVehicle` remains valid and `is_route_operational` stays structural.

- [ ] **Step 4: Run tests and confirm missing service behavior**

```bash
cargo test -p caelum-core --test bus_service --test transit_router
```

Expected before implementation: missing module/metrics and zero-fleet route still participates.

- [ ] **Step 5: Expose the exact live step timing helper**

Change only visibility of `transit::vehicle_step_seconds` to `pub(crate)`.

Do not call `traffic::effective_road_path_seconds` for cycle math: empty synthetic paths have different stored-total semantics there.

- [ ] **Step 6: Implement cycle/required/nominal math**

Core walk:

```rust
fn bus_round_trip_seconds(route: &Route, flow: &RoadFlow) -> Option<f64> {
    let mut total = 0.0;
    for leg in &route.legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            let seconds = crate::transit::vehicle_step_seconds(flow, TransitMode::Bus, step);
            if seconds > 0.0 {
                total += seconds;
            }
        }
    }
    (total.is_finite() && total > 0.0).then_some(total)
}

pub(crate) fn required_fleet(round_trip_seconds: f64, target: u32) -> usize {
    ((round_trip_seconds / f64::from(target)).ceil() as usize).max(1)
}
```

`metrics` reads assigned count from `route.vehicle_ids.len()`, derives required only when target exists, and nominal only when assigned count is non-zero.

- [ ] **Step 7: Publish metrics only on output snapshots**

Change `GameEngine::snapshot()` from a bare clone to:

```rust
pub fn snapshot(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot.clone();
    bus_service::populate_snapshot_metrics(&mut snapshot);
    snapshot
}
```

`populate_snapshot_metrics` derives `RoadFlow` once and fills every bus route's `service_metrics` on the clone.

Keep internal `self.snapshot` metrics `None`. Do not make commit/equality logic depend on presentation metrics.

Add tests that prove:

- `engine.snapshot()` returns expected `service_metrics`;
- a forged direct/input metric is cleared by normalization;
- `snapshot_for_save()` clears/omits `serviceMetrics` after its existing normalization pass.

- [ ] **Step 8: Gate only bus passenger planning on fleet presence**

In the bus branch of `router::active_services`:

```rust
if route.vehicle_ids.is_empty() {
    continue;
}
```

Do not change Metro or `is_route_operational`.

- [ ] **Step 9: Run focused timing/router/persistence regressions**

```bash
cargo test -p caelum-core --test bus_service --test transit_router --test router_planning --test router_estimate_branches --test shuttle_service --test persistence_snapshot --test persistence_determinism
```

Expected: Rust is the single source of service numbers; zero-fleet buses are not passenger services.

- [ ] **Step 10: Commit**

```bash
git add crates/caelum-core/src crates/caelum-core/tests
git commit -m "feat: derive bus service metrics in core"
```

---

### Task 3: Add replacement deployment flow, then make bus creation fleet-free

This task intentionally owns **both sides of the behavior break**. Do not remove the implicit first bus in an earlier commit and leave the suite/service fixtures without a replacement startup path.

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/src/bus_service.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/golden_sequences.rs`
- Modify: every bus-service fixture found by the inventory below
- Modify: `tests/e2e/routes.spec.ts`

**Interfaces:**

```rust
SetBusTargetHeadway { route_id: String, target_headway_seconds: u32 }
DeployBusFleet { route_id: String }
```

Rejections:

```text
InvalidHeadway
HeadwayNotSet
FleetAlreadyAssigned
```

- [ ] **Step 1: Inventory the real bus-creation blast radius before editing behavior**

Run:

```bash
rg -l 'GameIntent::CreateRoute|create_route\(' crates/caelum-core/tests
rg -n 'vehicle_ids|transit\.vehicles|AssignVehicle' crates/caelum-core/tests
rg -n 'finishing a bus route assigns a vehicle|vehicleIds' tests/e2e
```

At minimum review these current service-heavy files:

```text
transit_build.rs
trip_lifecycle.rs
transit_router.rs
route_resilience.rs
route_editing.rs
golden_sequences.rs
shuttle_service.rs
router_planning.rs
engine_smoke.rs
route_preview.rs
dual_road_routing.rs
persistence_* fixtures/tests
areas_buildings.rs
```

Classify each fixture:

- **needs live bus service** -> explicitly call existing `AssignVehicle` after route creation;
- **tests geometry/editor/lifecycle without movement** -> keep the new zero-fleet route;
- **tests HPA-624 deployment behavior** -> use Set target + Deploy, not `AssignVehicle`.

Do not weaken assertions merely to accommodate the new default.

- [ ] **Step 2: Write failing target validation/setup-only tests**

Assert:

```rust
SetBusTargetHeadway { target_headway_seconds: 60 } // applies
SetBusTargetHeadway { target_headway_seconds: 59 } // InvalidHeadway
```

Also prove:

- target set does not bump structural `revision`;
- same target is unchanged/no-op;
- after any vehicle is assigned, changing target rejects `FleetAlreadyAssigned`.

- [ ] **Step 3: Write failing deployment/cost tests**

Cover:

- no target -> `HeadwayNotSet`;
- inactive/broken route -> existing route rejection;
- exact Standard budget `required * BUS_COST` -> full fleet, budget reaches expected value;
- one unit short -> `InsufficientBudget`, zero buses added;
- Creative -> same fleet count, budget unchanged;
- second deploy -> `FleetAlreadyAssigned`;
- checked conversion/multiplication is used before cost authorization.

- [ ] **Step 4: Write deterministic placement tests**

Unequal loop: use a 400s cycle and `N=2`; second bus must land at offset `200s` inside the long step, not by stop/leg index.

Shuttle: reuse the `302s` vector and `N=2`:

```text
offset = 151s
151 - 100 - 0 = 51s into 200s return step
step_progress = 0.255
```

Assert stable IDs/cursors from identical source snapshots.

- [ ] **Step 5: Write structural-edit preservation regression**

Deploy multiple buses, make an existing structural route edit, and assert:

- current `rebase_edited_route_vehicles_and_riders` still parks/rebases cursors safely;
- vehicle count is unchanged;
- no deployment re-spacing runs;
- target stays persisted;
- derived nominal headway may change.

Do not assert preservation of initial spacing after edit.

- [ ] **Step 6: Implement target mutation**

```rust
pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    route_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot>
```

Rules:

```text
route exists
vehicle_ids empty
headway >= MIN_BUS_HEADWAY_SECONDS (60)
```

Reject `<60` with `InvalidHeadway`; reject already-running fleet with `FleetAlreadyAssigned`; do not bump route revision or alter fleet.

- [ ] **Step 7: Implement time-offset cursor resolution and atomic deployment**

Local cursor:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
struct ServiceCursor {
    itinerary_index: usize,
    path_step_index: usize,
    step_progress: f64,
}
```

Walk current path steps in itinerary order using `vehicle_step_seconds`:

```text
if d <= 0: skip
if remaining < d:
    progress = remaining / d
    return cursor
remaining -= d
```

Deployment order:

1. find bus route;
2. require active + connected;
3. require target;
4. require zero fleet;
5. derive one `RoadFlow`;
6. derive cycle/required fleet once;
7. checked-convert/multiply `required * BUS_COST`;
8. authorize full cost before mutation;
9. clone snapshot;
10. create buses in stable ID order with `initial_vehicle` against growing candidate;
11. set each cursor to `cycle * i / N`;
12. append route IDs + vehicles;
13. apply cost once.

Do not loop through `assign_vehicle_costed` and do not implement top-up.

- [ ] **Step 8: Add intent/rejection dispatch without changing `AssignVehicle`**

Extend `GameIntent` and `GameEngine::dispatch` using the existing mutation channel.

Keep `GameIntent::AssignVehicle` bus behavior unchanged. No new `GameBackend` method.

- [ ] **Step 9: Only now remove the implicit bus from creation/preview**

Change route insertion to accept explicit vehicle IDs:

```rust
fn insert_route(
    snapshot: &mut GameSnapshot,
    mode: TransitMode,
    route_id: String,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    legs: Vec<RouteLegPath>,
    vehicle_ids: Vec<String>,
) -> GameplayResult<()>;
```

Creation policy:

```text
Bus   -> vehicle_ids [], no vehicle push, nominal creation vehicle cost 0
Metro -> existing one initial vehicle + existing cost
```

Preview uses the same mode-specific creation cost:

```rust
let initial_vehicle_cost = if request.route_id.is_none() && request.mode == TransitMode::Metro {
    transit::vehicle_cost(TransitMode::Metro)
} else {
    0
};
```

Do not alter `update_route`'s rebase call.

- [ ] **Step 10: Migrate every service-dependent Rust fixture in the same task**

Apply the Step-1 classification. Existing tests that simply need the pre-HPA-624 “route is running” fixture should explicitly dispatch:

```rust
GameIntent::AssignVehicle {
    mode: "bus".to_string(),
    line_id: route_id.to_string(),
}
```

Do not convert ordinary resilience/router fixtures to Deploy unless they are testing service setup itself.

- [ ] **Step 11: Re-point the existing route E2E regression immediately**

In `tests/e2e/routes.spec.ts`, replace the old guard:

```text
"finishing a bus route assigns a vehicle and runs live transit"
```

with a fleet-free creation guard that proves:

```text
Save bus route
route exists
vehicleIds == []
transit.vehicles has no bus for that route
Lines row reports No fleet once Task 4/5 UI exists; before that, state assertion is sufficient
```

Remove the old comment that protects the dropped `assignVehicle` step. The actual Set -> Deploy -> running-service E2E is Task 6.

- [ ] **Step 12: Put deployed-fleet granularity coverage beside the existing invariant**

Add the coarse-vs-fine deployed bus case in `crates/caelum-core/tests/golden_sequences.rs`, next to existing granularity-independent vehicle goldens.

Do not duplicate the same invariant in `bus_service.rs` tests.

- [ ] **Step 13: Run the full core suite now, not at the end**

```bash
cargo test -p caelum-core
```

Then run the focused route E2E regression:

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Expected: no hidden implicit-vehicle assumptions remain in core; route creation is fleet-free and Metro still creates its first vehicle.

- [ ] **Step 14: Commit**

```bash
git add crates/caelum-core tests/e2e/routes.spec.ts
git commit -m "feat: start bus service from headway"
```

---

### Task 4: Wire Rust-derived service metrics through runtime selectors

There is **no** `src/domain/busService.ts` and no TypeScript congestion multiplier in this task.

**Files:**
- Modify: `src/domain/types.ts` rejection additions if not already present
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/snapshotView.test.ts` if raw `serviceMetrics` normalization needs coverage

**Interfaces:**

```ts
setBusTargetHeadway(routeId: string, targetHeadwaySeconds: number): RuntimeCommandResult;
deployBusFleet(routeId: string): RuntimeCommandResult;
```

Route row consumes Rust-derived:

```ts
route.serviceMetrics?.requiredFleet
route.serviceMetrics?.nominalHeadwaySeconds
route.serviceMetrics?.assignedFleet
```

- [ ] **Step 1: Write failing runtime/selector tests**

Cover:

- active connected bus + zero assigned -> `status.primary === "noFleet"`;
- row uses supplied Rust `serviceMetrics` verbatim rather than recomputing path timing;
- pre-deployment target + `requiredFleet` is available to UI state;
- post-deployment nominal + assigned fleet is available;
- Metro row has no bus service state.

Add one deliberate fixture where route path timing would disagree with supplied `serviceMetrics`; assert selector displays the supplied Rust values. This protects against accidentally reintroducing TS timing math.

- [ ] **Step 2: Re-point stale unaffordable-route selector coverage to Metro**

Current selector coverage that expects:

```text
Need $8,000.
```

from a bus draft becomes unreachable after bus creation cost becomes zero. Keep the affordability behavior test, but construct a Metro draft and expect the current Metro cost instead.

Do not retain a stub-only “unaffordable bus creation” scenario.

- [ ] **Step 3: Extend backend/runtime intent types**

Add:

```ts
| {
    type: "setBusTargetHeadway";
    routeId: string;
    targetHeadwaySeconds: number;
  }
| { type: "deployBusFleet"; routeId: string }
```

Add rejection strings:

```text
invalidHeadway
headwayNotSet
fleetAlreadyAssigned
```

No new `GameBackend` method: both use `dispatch`.

- [ ] **Step 4: Add runtime controller methods through existing serialized dispatch**

Follow the current route mutation pattern:

```ts
setBusTargetHeadway(routeId, targetHeadwaySeconds) {
  return dispatchGameplayIntent({
    type: "setBusTargetHeadway",
    routeId,
    targetHeadwaySeconds,
  });
},

deployBusFleet(routeId) {
  return dispatchGameplayIntent({ type: "deployBusFleet", routeId });
},
```

Use the actual existing dispatch helper name in `createGameRuntime.ts`. No optimistic local mutation or second queue.

- [ ] **Step 5: Derive only presentation state**

Status precedence:

```text
broken -> paused -> noFleet(bus only) -> running
```

Selector maps route-owned Rust values into a small row shape, for example:

```ts
interface ShellBusServiceState {
  targetHeadwaySeconds: number | null;
  roundTripSeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}
```

No route-leg walk, flow lookup, congestion multiplier, or required-fleet formula exists in TypeScript.

- [ ] **Step 6: Add concise rejection copy**

```text
invalidHeadway -> "Headway must be at least 1 minute."
headwayNotSet -> "Set a target headway before deploying buses."
fleetAlreadyAssigned -> "This route already has a bus fleet."
```

Existing budget copy handles unaffordable deployment.

- [ ] **Step 7: Run focused runtime tests and type checking**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/snapshotView.test.ts
bun run check
```

Expected: UI state is a pure projection of Rust metrics.

- [ ] **Step 8: Commit**

```bash
git add src/domain src/runtime tests/runtime
git commit -m "feat: expose bus service controls to runtime"
```

---

### Task 5: Add the compact pre-deployment Lines-panel setup flow

**Files:**
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**

```ts
onSetBusTargetHeadway(routeId: string, targetHeadwaySeconds: number): void;
onDeployBusFleet(routeId: string): void;
```

- [ ] **Step 1: Write failing pre-deployment UI tests**

For a zero-fleet bus with Rust-derived `requiredFleet = 3`, assert:

```text
No fleet
Target
Required
3 buses
Set
Deploy 3 buses
```

Enter `6` minutes and Set; assert:

```ts
onSetBusTargetHeadway(route.id, 360)
```

Deploy asserts:

```ts
onDeployBusFleet(route.id)
```

Input properties must include whole-minute guardrails (`min=1`, `step=1`).

- [ ] **Step 2: Write failing post-deployment/Metro UI tests**

For a bus with assigned fleet:

```text
Target 6 min
Nominal 5.8 min
Fleet 3
```

Assert there is **no** editable headway input, Deploy button, `assigned / required` control, or plus-one AssignVehicle button after fleet exists.

Assert Metro rows render none of the bus service block.

- [ ] **Step 3: Run focused UI tests**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Expected before implementation: missing service block/callbacks.

- [ ] **Step 4: Add route-keyed headway minute draft only for zero-fleet routes**

Reuse the route-name local draft style:

```ts
let headwayMinuteDrafts = $state<Record<string, string>>({});
```

Set input:

```html
<input type="number" min="1" step="1" ... />
```

Parse a positive whole minute and dispatch `minutes * 60`. UI validation is convenience; Rust's 60s floor is authoritative.

- [ ] **Step 5: Render Rust-derived values without transport math**

Only formatting is allowed:

```ts
function formatHeadway(seconds: number | null): string {
  return seconds === null ? "—" : `${(seconds / 60).toFixed(1)} min`;
}
```

Pre-deployment button label uses `requiredFleet` supplied by Rust. Do not calculate it in Svelte.

Post-deployment hides setup controls and shows Target/Nominal/Fleet only.

- [ ] **Step 6: Pass callbacks from App.svelte**

Follow existing rename/recolor/toggle route actions. No new context/store.

- [ ] **Step 7: Add minimal CSS only**

Reuse route-row button/input tokens. No new component hierarchy or operations screen.

- [ ] **Step 8: Run UI checks**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/App.svelte src/components/hud/panels/LinesPanel.svelte src/styles.css tests/ui
git commit -m "feat: configure bus service from lines panel"
```

---

### Task 6: Prove the real setup loop and run full regression verification

**Files:**
- Modify: `tests/e2e/routes.spec.ts` (extend/add the player-visible deployment flow)
- Modify other files only for verified regressions discovered by full-suite execution

**Interfaces:**
- Verifies the browser/WASM player path using the same shared Svelte runtime as desktop.
- Owns verification, not schema cleanup or hidden fixture migration.

- [ ] **Step 1: Add/extend one real bus-service E2E**

Reuse the existing route setup in `routes.spec.ts`:

```text
create/open sandbox
build road + bus stops
save bus route
assert No fleet / zero vehicle IDs
set target to a whole-minute value
assert Required N uses the Rust-derived row value
click Deploy N buses
assert runtime route has N vehicleIds
assert UI shows Target, Nominal, Fleet N and no setup controls
Resume
assert clock advances
```

Do not wait for a commute, inspect vehicle pixels, or manufacture congestion in E2E. Timing correctness belongs to Rust tests.

- [ ] **Step 2: Run focused route E2E**

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Expected: fleet-free creation plus Set -> Deploy -> running service works end-to-end.

- [ ] **Step 3: Run complete Rust/TS/build-quality verification**

```bash
cargo test --workspace
bun run test:unit
bun run check
bun run format:check
bun run lint
```

Expected: all pass.

- [ ] **Step 4: Run the full E2E suite once**

```bash
bun run test:e2e
```

Expected: existing route editing, persistence, traffic, shuttle, and new service startup flows pass.

- [ ] **Step 5: Verify no active v6 leftovers**

```bash
rg -n 'schema[- ]?v?6|schema.?6|cities-v6|caelum-city-saves-v6|SNAPSHOT_SCHEMA_VERSION.?=.?6' \
  crates src src-tauri tests docs/architecture.md
```

Any active match is a Task-1 miss. Historical specs/plans are intentionally outside this inventory.

- [ ] **Step 6: Verify scope stayed lean**

Final diff must not contain:

```text
src/domain/busService.ts
TypeScript congestion/service timing formula
Metro headway/service fields or UI
service bands/timetable/departure history
post-deployment headway editing
fleet top-up/withdrawal/reassignment
auto-resize/re-spacing
holding/bunching logic
player plus-one AssignVehicle control
generic fleet/service manager
migration/fallback reader
new route visibility layer
```

Also verify it still preserves:

```text
existing structural route-edit rebase
existing low-level AssignVehicle support
Metro initial vehicle behavior
```

- [ ] **Step 7: Commit E2E/final regression fixes**

```bash
git add tests/e2e/routes.spec.ts
git commit -m "test: cover bus service startup loop"
```

## Plan self-review

- **Review finding 1:** TypeScript timing port removed. Rust fills serialize-only `Route.serviceMetrics` on output snapshots; persistence clears/ignores it.
- **Review finding 2:** Implicit bus removal moved to Task 3 beside the replacement deployment flow; fixture migration and full core suite happen there.
- **Review finding 3:** UX concern accepted, but incremental top-up rejected as out of slice. Target is pre-deployment only; after deployment UI shows Target/Nominal/Fleet without an unreachable required-fleet control.
- **Review finding 4:** `MIN_BUS_HEADWAY_SECONDS = 60`, backed by Rust and `min=1/step=1` whole-minute UI.
- **Review finding 5:** `Nominal` replaces Current/Actual; deployed-fleet granularity lives in `golden_sequences.rs`; unaffordable creation selector coverage moves from bus to Metro.
- **Authority:** Rust alone owns timing, required fleet, deployment count/cost, and placement. TypeScript normalizes/formats and dispatches.
- **YAGNI:** No Metro service plan, repeated fleet management, scheduler, history, holding/bunching, or migration work enters HPA-624.
