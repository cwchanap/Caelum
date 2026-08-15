# HPA-624 Bus Headway and Initial Fleet Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate bus route geometry from service operation by letting a new bus route exist with zero fleet, setting one target headway, deriving required fleet from current congestion-aware round-trip time, and atomically deploying an evenly time-spaced initial fleet from the existing Lines panel.

**Architecture:** Keep authority in `caelum-core`: a bus-only `bus_service` module owns headway validation, live round-trip/fleet math, and initial deployment. Persist only `Route.targetHeadwaySeconds`; derive round-trip/required/current-headway values from current route paths instead of caching them. Reuse `transit::vehicle_step_seconds` so loop and shuttle service math exactly matches live bus cursor timing. TypeScript ports that current-path step walk for display only; Rust remains authoritative for count, cost, and placement. Preserve the existing structural route-edit rebase and the low-level `AssignVehicle` intent; neither becomes player-facing fleet management.

**Tech Stack:** Rust (`caelum-core`, serde), Svelte 5 + TypeScript, existing runtime/backend intent bridge, Vitest, Playwright, Bun, Tauri/IndexedDB persistence.

## Global Constraints

- Implement HPA-624 only; HPA-334 remains the coordination parent.
- Bus only: do not add Metro headway/service-plan behavior.
- New bus routes have zero vehicles; new Metro lines retain the current initial vehicle.
- Persist one required-nullable `targetHeadwaySeconds` on bus `Route` only.
- Snapshot/database namespace becomes v7 directly; do not add migration or compatibility code.
- Required fleet is `max(1, ceil(roundTripSeconds / targetHeadwaySeconds))`.
- Round-trip and spacing walk `Route.legs[*].current_path` only and use the same effective per-step timing as live buses.
- Empty/zero-step shuttle reversals contribute zero; U-turn/multi-step reversals contribute their real current-path step durations.
- Initial fleet deployment is one-shot from zero vehicles and atomic under `CostPolicy`.
- Structural route edits keep the existing vehicle/rider rebase; do not suppress it and do not re-space by headway afterward.
- Keep `GameIntent::AssignVehicle` as the existing unspaced engine/test add; do not expose a plus-one Lines-panel control and do not reject it in this slice.
- TypeScript bus-service metrics are presentation-only and must match Rust on the same vectors; never use `estimatedSeconds` or `lastValidPath` as fallback timing.
- Do not add service bands, timetables, holding, bunching, fleet resizing/withdrawal/reassignment, depots, vehicle inventories, or generic scheduler/fleet/service-plan abstractions.

## File structure

**Create**

- `crates/caelum-core/src/bus_service.rs` — bus-only current service metrics, headway mutation, time-offset cursor placement, and atomic initial deployment.
- `crates/caelum-core/tests/bus_service.rs` — loop/shuttle service math, headway, deployment, spacing, cost, and edit-rebase coverage.
- `src/domain/busService.ts` — presentation-only port of current bus service timing.

**Modify**

- `crates/caelum-core/src/lib.rs` — register `bus_service`.
- `crates/caelum-core/src/model.rs` — schema v7 and required-nullable `Route.target_headway_seconds`.
- `crates/caelum-core/src/intent.rs` — `SetBusTargetHeadway` and `DeployBusFleet`.
- `crates/caelum-core/src/engine.rs` — dispatch the two intents and update active schema-v6 documentation to v7.
- `crates/caelum-core/src/route_editor.rs` — bus creation inserts zero vehicles; Metro creation remains current behavior; keep edit rebase unchanged.
- `crates/caelum-core/src/preview.rs` — new bus preview has zero initial vehicle cost; Metro preview remains current behavior.
- `crates/caelum-core/src/router.rs` — zero-fleet bus routes are not passenger services.
- `crates/caelum-core/src/rejection.rs` — `InvalidHeadway`, `HeadwayNotSet`, `FleetAlreadyAssigned`.
- `crates/caelum-core/src/transit.rs` — expose the existing `vehicle_step_seconds` helper as `pub(crate)`; do not move ticking or change its semantics.
- `crates/caelum-core/tests/model_wire_format.rs` — v7 route wire contract.
- `crates/caelum-core/tests/route_editing.rs` — fleet-free bus create, unchanged Metro create/preview, and existing edit semantics.
- `crates/caelum-core/tests/economy_cost_policy.rs` — zero-cost bus creation and atomic fleet cost.
- `crates/caelum-core/tests/transit_router.rs` — zero-fleet exclusion and explicit `AssignVehicle` eligibility.
- Existing Rust fixtures that instantiate `Route` — explicit `target_headway_seconds: None`.
- `src/domain/types.ts` — schema v7, route field, new rejection codes.
- `src/domain/traffic.ts` — export the existing congestion multiplier semantics for presentation math.
- `src/runtime/backend/types.ts` — v7 active comment plus two new intent variants.
- `src/runtime/types.ts` — bus service row state, `noFleet`, runtime controller methods.
- `src/runtime/createGameRuntime.ts` — dispatch headway/deployment commands.
- `src/runtime/runtimeSelectors.ts` — derive bus service row metrics/status.
- `src/runtime/rejectionMessages.ts` — user-facing service-control failures.
- `src/components/hud/panels/LinesPanel.svelte` — compact target/current/fleet controls for buses only.
- `src/App.svelte` — pass callbacks to LinesPanel.
- `src/styles.css` — minimal service-block layout.
- `src/persistence/indexedDbCitySaveStore.ts` — v7 browser namespace.
- `src-tauri/src/city_store.rs` — `cities-v7` native namespace.
- `tests/fixtures/rustSnapshot.ts` and route fixtures — v7 + required nullable bus route field.
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` and native city-store tests — v7 namespace expectations.
- `tests/runtime/runtimeSelectors.test.ts`, `tests/runtime/gameRuntime.test.ts` — exact display/runtime behavior.
- `tests/ui/linesPanel.test.ts`, `tests/ui/appShell.test.ts` — bus-only service controls.
- `tests/e2e/smoke.spec.ts` — real create -> headway -> deploy smoke.
- `docs/architecture.md` — active schema version contract moves to v7 in Task 1.

---

### Task 1: Make bus route creation fleet-free and complete the direct schema-v7 break

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: direct Rust `Route { ... }` fixtures reported by compile
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts` active schema comment
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Modify: native city-store namespace assertions
- Modify: `docs/architecture.md`

**Interfaces:**
- Produces: Rust `Route.target_headway_seconds: Option<u32>` serialized as required `targetHeadwaySeconds: number | null`.
- Produces: active snapshot/storage version `7` everywhere that describes current behavior.
- Produces: new bus route `vehicle_ids == []`; new Metro line behavior unchanged.
- Preserves: `RoutePreviewResponse.initial_vehicle_cost` and `affordable` wire fields.

- [ ] **Step 1: Write/adjust failing Rust wire and route-creation tests**

Add assertions equivalent to:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 7);

let route_json = serde_json::to_value(&snapshot.transit.routes[0]).unwrap();
assert_eq!(route_json["targetHeadwaySeconds"], serde_json::Value::Null);

let created_bus = create_test_bus_route(&state);
assert!(created_bus.transit.routes[0].vehicle_ids.is_empty());
assert!(created_bus.transit.vehicles.is_empty());
assert_eq!(created_bus.budget, state.budget);

let created_metro = create_test_metro_line(&state);
assert_eq!(created_metro.transit.metro_lines[0].vehicle_ids.len(), 1);
assert_eq!(created_metro.transit.vehicles.len(), 1);
```

In preview tests, assert a new bus route reports `initial_vehicle_cost == 0` and cannot fail solely for bus purchase budget, while equivalent Metro preview still reports `METRO_COST`.

- [ ] **Step 2: Run focused tests and confirm the old coupling fails**

```bash
cargo test -p caelum-core --test model_wire_format --test route_editing --test economy_cost_policy
```

Expected before implementation: failures around schema version/required field and bus creation still inserting/charging one vehicle.

- [ ] **Step 3: Add the required nullable route field and direct v7 storage break**

Rust:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 7;

pub struct Route {
    // existing fields...
    #[serde(deserialize_with = "deserialize_required_option")]
    pub target_headway_seconds: Option<u32>,
}
```

TypeScript:

```ts
export const SNAPSHOT_SCHEMA_VERSION = 7 as const;

export interface Route {
  // existing fields...
  targetHeadwaySeconds: number | null;
}
```

Storage namespaces:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v7";
const DATABASE_VERSION = 7;
```

```rust
const CITY_DIRECTORY: &str = "cities-v7";
```

Every engine-created bus route starts with `target_headway_seconds: None`. Update direct fixtures explicitly; do not add `#[serde(default)]`, fallback readers, aliases, or migration.

- [ ] **Step 4: Decouple only bus creation from the initial vehicle**

Change `insert_route` to accept a concrete vector:

```rust
fn insert_route(
    snapshot: &mut GameSnapshot,
    mode: TransitMode,
    route_id: String,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    legs: Vec<RouteLegPath>,
    vehicle_ids: Vec<String>,
) -> GameplayResult<()> {
    // bus Route stores vehicle_ids + target_headway_seconds: None
    // MetroLine keeps current vehicle_ids semantics
}
```

In `create_route_costed`, create/charge the initial vehicle only for `TransitMode::Metro`. For `TransitMode::Bus`, quote zero vehicle cost, insert `vehicle_ids: vec![]`, and do not push a vehicle.

Make preview use the same mode-specific policy:

```rust
let initial_vehicle_cost = if request.route_id.is_none() && request.mode == TransitMode::Metro {
    transit::vehicle_cost(TransitMode::Metro)
} else {
    0
};
```

Do not change `update_route`'s call to `rebase_edited_route_vehicles_and_riders`.

- [ ] **Step 5: Compile and make every current v6 assertion explicit in Task 1**

Run:

```bash
cargo test -p caelum-core --no-run
bun run check
```

For every compiler-reported Rust `Route { ... }`, add:

```rust
target_headway_seconds: None,
```

For each TypeScript bus-route fixture, add:

```ts
targetHeadwaySeconds: null,
```

Then inventory active v6 wording/namespace assertions:

```bash
rg -n 'schema[- ]?v?6|schema.?6|cities-v6|caelum-city-saves-v6|SNAPSHOT_SCHEMA_VERSION.?=.?6' \
  crates src src-tauri tests docs/architecture.md
```

Update **current code/tests/architecture only**, including `GameEngine::from_snapshot` and `src/runtime/backend/types.ts` comments. Do not rewrite historical specs/plans merely because they document the completed v6 change.

- [ ] **Step 6: Run focused + persistence contract tests**

```bash
cargo test -p caelum-core --test model_wire_format --test route_editing --test economy_cost_policy
bun run test:unit -- tests/runtime/persistence/indexedDbCitySaveStore.test.ts
cargo test -p caelum-tauri city_store
```

If the Tauri package name differs, use the existing targeted city-store test command from the repository. Expected: bus creation fleet-free, Metro behavior unchanged, and active persistence contracts on v7.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core src src-tauri tests docs/architecture.md
git commit -m "feat: separate bus route creation from fleet"
```

---

### Task 2: Add bus-only live service math and zero-fleet passenger gating

**Files:**
- Create: `crates/caelum-core/src/bus_service.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/router.rs`
- Create: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`

**Interfaces:**

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct BusServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub current_headway_seconds: Option<f64>,
}

pub(crate) fn metrics(route: &Route, flow: &RoadFlow) -> Option<BusServiceMetrics>;
pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize;
```

Reuses exactly:

```rust
pub(crate) fn vehicle_step_seconds(
    flow: &RoadFlow,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64;
```

- [ ] **Step 1: Write failing loop/headway boundary tests**

Lock basic formula vectors:

```text
round trip 600s, target 300s -> required 2
round trip 601s, target 300s -> required 3
round trip 600s, target unset -> required None
```

Build an unequal-duration loop fixture and assert the cycle is the sum of effective current path step times, not stop or leg count.

- [ ] **Step 2: Add the required shuttle timing vectors**

Use one synthetic shuttle `Route.legs` sequence with current road paths:

```text
leg 0 outbound service:  one step, 100s
leg 1 reversal:          zero steps, 0s
leg 2 return service:    one step, 200s
leg 3 reversal:          one U-turn step, 2s
```

Assert:

```rust
assert_eq!(metrics(...).unwrap().round_trip_seconds, 302.0);
```

Then set `RoadFlow` to `8` at the outbound step position. Existing capacity `4` gives `2.0x`, so the same route becomes:

```rust
assert_eq!(metrics(...).unwrap().round_trip_seconds, 402.0);
```

This proves empty reversals contribute zero while U-turn reversal steps participate in live timing. Add a second fixture only if needed to cover an existing multi-step roundabout reversal; do not create a shuttle-specific abstraction.

- [ ] **Step 3: Add zero-fleet + `AssignVehicle` passenger-routing tests**

In `transit_router.rs`:

1. create an active connected bus route with `vehicle_ids = []`;
2. assert `find_route_plan` does not return that bus line;
3. dispatch or apply the existing `AssignVehicle` seam once;
4. assert the route becomes passenger-service eligible.

This locks the policy that `AssignVehicle` remains a valid low-level unspaced add even though the intended player setup uses headway + deployment.

- [ ] **Step 4: Run the new tests and confirm failures**

```bash
cargo test -p caelum-core --test bus_service --test transit_router
```

Expected before implementation: missing `bus_service` API and zero-fleet bus still appears in `active_services`.

- [ ] **Step 5: Expose the live per-step timing seam unchanged**

Make the existing private helper in `transit.rs` crate-visible:

```rust
pub(crate) fn vehicle_step_seconds(
    flow: &RoadFlow,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64
```

Do not route service-cycle math through `traffic::effective_road_path_seconds`: empty synthetic paths keep a stored total there, while live movement skips zero-step legs. `bus_service` must match live step semantics.

- [ ] **Step 6: Implement current-path round-trip and required/current headway**

In `bus_service.rs`:

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
    (total > 0.0 && total.is_finite()).then_some(total)
}

pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize {
    ((round_trip_seconds / f64::from(target_headway_seconds)).ceil() as usize).max(1)
}
```

Do not inspect `last_valid_path` or `estimated_seconds`. `metrics` uses `route.vehicle_ids.len()` for assigned fleet and derives current headway only when assigned fleet is non-zero.

- [ ] **Step 7: Gate passenger routing on actual bus fleet**

In `router::active_services`, keep the existing structural check and add only:

```rust
if route.vehicle_ids.is_empty() {
    continue;
}
```

Do not change `is_route_operational`.

- [ ] **Step 8: Run focused tests**

```bash
cargo test -p caelum-core --test bus_service --test transit_router --test router_planning --test router_estimate_branches --test shuttle_service
```

Expected: loop/shuttle current-path timing and passenger eligibility are deterministic.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core/src/bus_service.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/router.rs crates/caelum-core/tests/bus_service.rs crates/caelum-core/tests/transit_router.rs
git commit -m "feat: derive bus service metrics"
```

---

### Task 3: Add authoritative headway setting and atomic deterministic initial deployment

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/src/bus_service.rs`
- Modify: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/engine_smoke.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs` if the existing structural-edit rebase regression belongs there instead of `bus_service.rs`

**Interfaces:**

```rust
SetBusTargetHeadway { route_id: String, target_headway_seconds: u32 }
DeployBusFleet { route_id: String }
```

Produces rejection codes:

```text
InvalidHeadway
HeadwayNotSet
FleetAlreadyAssigned
```

Deployment reuses `BUS_COST`, `CostPolicy`, `initial_vehicle`, and Task 2 metrics.

- [ ] **Step 1: Add failing headway/dispatch/cost tests**

Assert:

```rust
let before_revision = route.revision;
let result = engine.dispatch(GameIntent::SetBusTargetHeadway {
    route_id: route.id.clone(),
    target_headway_seconds: 300,
});
assert!(result.applied);
assert_eq!(result.snapshot.transit.routes[0].target_headway_seconds, Some(300));
assert_eq!(result.snapshot.transit.routes[0].revision, before_revision);
```

Also assert:

- headway `0` -> `InvalidHeadway`;
- deploy without target -> `HeadwayNotSet`;
- Standard budget exactly `required * BUS_COST` reaches zero;
- one unit below -> `InsufficientBudget` and zero vehicles added;
- Creative deploys same count with budget unchanged;
- second deploy -> `FleetAlreadyAssigned` with unchanged budget/fleet.

- [ ] **Step 2: Add failing unequal-loop spacing test**

Use a 400-second cycle with `N = 2`. Vehicle 0 starts at offset `0`; vehicle 1 resolves at offset `200` inside the longer leg rather than merely at a stop boundary. Assert stable vehicle IDs/cursors from two identical source snapshots.

- [ ] **Step 3: Add failing shuttle spacing test**

Reuse Task 2's exact 302-second shuttle vector. For `N = 2`, vehicle 1 offset is `151s`:

```text
151 - 100 outbound - 0 empty reversal = 51s into the 200s return step
stepProgress = 51 / 200 = 0.255
```

Assert the second vehicle lands on the return service leg at `step_progress == 0.255` (within the repository's normal float tolerance), not on the empty reversal and not at a stop-index approximation.

- [ ] **Step 4: Add a structural-edit policy regression**

Create/deploy a multi-bus route, perform an existing structural route edit, and assert the normal `rebase_edited_route_vehicles_and_riders` outcome still occurs: vehicles are parked/rebased with valid reset cursors. Do **not** assert preservation of deployment spacing.

Also assert the edit does not add/delete fleet and does not invoke automatic headway re-spacing. Assigned/required mismatch after the edit is allowed.

- [ ] **Step 5: Run focused tests and confirm missing behavior**

```bash
cargo test -p caelum-core --test bus_service --test economy_cost_policy --test engine_smoke --test route_editing
```

Expected before implementation: missing intents/rejections/deployment.

- [ ] **Step 6: Implement headway mutation**

```rust
pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    route_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot>
```

Reject zero with `InvalidHeadway`; reject non-bus IDs with `RouteNotFound`; clone once; set the field; return unchanged when identical. Do not touch route revision, fleet, or route-edit rebase behavior.

- [ ] **Step 7: Implement a pure time-offset-to-cursor helper**

Local shape:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
struct ServiceCursor {
    itinerary_index: usize,
    path_step_index: usize,
    step_progress: f64,
}
```

Walk `current_path` steps in itinerary order. For each effective duration `d` from `vehicle_step_seconds`:

```text
if d <= 0: skip
if remaining < d:
    progress = remaining / d
    return current cursor
remaining -= d
```

Zero-step legs naturally contribute nothing. Do not use `estimated_seconds`, `last_valid_path`, stop count, or leg count.

- [ ] **Step 8: Implement atomic initial deployment**

In `deploy_initial_fleet`:

1. locate the bus route;
2. require `active` and all connected legs;
3. require positive target headway;
4. require `vehicle_ids.is_empty()`;
5. derive `RoadFlow` once from the source snapshot;
6. derive current round trip and `required_fleet` once;
7. compute cost with checked integer conversion/multiplication and quote `required_fleet * BUS_COST` before mutation;
8. clone the snapshot;
9. create buses in stable index order with `initial_vehicle` against the growing candidate;
10. set each cursor from `round_trip * i / required_fleet`;
11. append IDs to the route and vehicles to the network;
12. apply authorized cost once;
13. return the candidate.

Do not call `assign_vehicle_costed` in a loop and do not partially deploy affordable buses.

- [ ] **Step 9: Preserve existing `AssignVehicle` unchanged**

Do not delete or reject the bus variant. Its policy remains:

- low-level engine/test add;
- unspaced cursor;
- immediately makes a valid bus route passenger-service eligible;
- makes later `DeployBusFleet` fail `FleetAlreadyAssigned`;
- not exposed as a player plus-one control by HPA-624.

Run existing `route_resilience` coverage because its fixtures already dispatch `AssignVehicle` after creating a bus route.

- [ ] **Step 10: Dispatch the new intents through `GameEngine`**

Add direct match arms following existing gameplay mutation handling. Do not add a new host method or command channel.

- [ ] **Step 11: Prove live movement determinism after deployment**

Clone one deployed snapshot, advance one copy with a coarse tick and the other with equivalent fine ticks, then compare bus cursor state. Use the real HPA-622 road-flow timing path.

Run:

```bash
cargo test -p caelum-core --test bus_service --test economy_cost_policy --test engine_smoke --test route_editing --test route_resilience --test golden_sequences --test shuttle_service
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add crates/caelum-core/src crates/caelum-core/tests
git commit -m "feat: deploy bus fleet from target headway"
```

---

### Task 4: Port current-path service metrics to TypeScript and wire runtime commands

**Files:**
- Create: `src/domain/busService.ts`
- Modify: `src/domain/traffic.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Create or modify: focused `src/domain/busService.ts` unit test under the existing runtime/ui Vitest layout
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**

```ts
export interface BusServiceMetrics {
  roundTripSeconds: number;
  targetHeadwaySeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  currentHeadwaySeconds: number | null;
}

export function selectBusServiceMetrics(
  state: GameState,
  route: Route,
): BusServiceMetrics | null;
```

Runtime controller additions:

```ts
setBusTargetHeadway(routeId: string, targetHeadwaySeconds: number): RuntimeCommandResult;
deployBusFleet(routeId: string): RuntimeCommandResult;
```

- [ ] **Step 1: Write failing cross-language-equivalent metric vectors**

Use the same values as Rust, not approximate alternatives:

```text
600 / target 300 -> required 2
601 / target 300 -> required 3
shuttle: 100 + 0 + 200 + 2 = 302
shuttle with flow 8 on 100s outbound point -> 200 + 0 + 200 + 2 = 402
```

Add a fixture where `estimatedSeconds` and/or `lastValidPath` deliberately disagree with `currentPath`; assert the helper still returns the current-path result.

Add zero-fleet expectation `currentHeadwaySeconds: null`.

- [ ] **Step 2: Run focused TS tests**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/gameRuntime.test.ts
```

Also run the new bus-service helper test path explicitly if it is not selected by those files. Expected before implementation: missing helper/field/controller commands.

- [ ] **Step 3: Export the existing TypeScript congestion multiplier semantics**

```ts
export function congestionMultiplier(flow: number): number {
  return Math.min(
    MAX_CONGESTION_MULTIPLIER,
    Math.max(1, flow / ROAD_FLOW_CAPACITY),
  );
}
```

Do not add new traffic tuning values.

- [ ] **Step 4: Implement `selectBusServiceMetrics` as a port of live step timing**

Build a point->flow lookup once from `selectTrafficFlow(state)`. For every route leg:

```ts
const path = leg.currentPath;
if (path === null) return null;

for (const step of path.steps) {
  const seconds =
    path.kind === "road"
      ? step.travelSeconds * congestionMultiplier(flowAt(step.position))
      : step.travelSeconds;
  if (seconds > 0) roundTripSeconds += seconds;
}
```

For this bus-only helper, route paths should be road paths; keep the code panic-free if malformed data supplies another path kind, but do not fall back to `lastValidPath`, `estimatedSeconds`, or stored empty-path totals.

Compute required/current headway with the exact same formulas as Rust. This file must not mutate state or dispatch intents.

- [ ] **Step 5: Extend runtime/backend contracts**

Add intent variants:

```ts
| {
    type: "setBusTargetHeadway";
    routeId: string;
    targetHeadwaySeconds: number;
  }
| { type: "deployBusFleet"; routeId: string }
```

Add rejection codes:

```text
invalidHeadway
headwayNotSet
fleetAlreadyAssigned
```

Add `ShellBusServiceState` and optional/null bus-service state to route rows; Metro rows use `null`. Add `noFleet` to `RouteServiceStatus.primary`.

No new `GameBackend` method is required because both mutations go through `dispatch`.

- [ ] **Step 6: Wire controller methods through the existing serialized dispatch path**

Follow existing route mutation methods:

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

Use the actual helper name in `createGameRuntime.ts`; do not create a parallel queue or optimistic local mutation.

- [ ] **Step 7: Derive row status/service metrics and rejection copy**

Status precedence:

```text
broken -> paused -> noFleet(bus only) -> running
```

Messages:

```text
invalidHeadway -> "Headway must be greater than zero."
headwayNotSet -> "Set a target headway before deploying buses."
fleetAlreadyAssigned -> "This route already has its initial fleet."
```

Budget rejection continues through existing copy.

- [ ] **Step 8: Run focused runtime tests and type checking**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/gameRuntime.test.ts
bun run check
```

Run the bus-service helper test explicitly and require the 302/402 shuttle vectors to pass before proceeding.

- [ ] **Step 9: Commit**

```bash
git add src/domain src/runtime tests/runtime
git commit -m "feat: expose bus service controls to runtime"
```

---

### Task 5: Add the compact Lines-panel player setup loop

**Files:**
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**
- Consumes: `ShellRouteListItem.busService` from Task 4.
- Consumes callbacks:

```ts
onSetBusTargetHeadway(routeId: string, targetHeadwaySeconds: number): void;
onDeployBusFleet(routeId: string): void;
```

- [ ] **Step 1: Write failing LinesPanel tests**

For a zero-fleet bus row, assert:

```text
No fleet
Target
Current
Fleet
0 / <required>
Set
Deploy <required> buses
```

Entering `6` minutes and pressing Set invokes:

```ts
onSetBusTargetHeadway(route.id, 360)
```

Deploy invokes `onDeployBusFleet(route.id)`.

Assert Metro rows render none of these bus-service controls. Also assert no player-facing `Assign vehicle`/`Add bus` plus-one control appears; HPA-624's player path is Set -> Deploy only.

- [ ] **Step 2: Run UI tests and confirm failure**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Expected before implementation: missing controls/callbacks.

- [ ] **Step 3: Add local headway-minute draft state**

Follow the existing route-name draft pattern:

```ts
let headwayMinuteDrafts = $state<Record<string, string>>({});
```

Display canonical target minutes when no local draft exists. On Set, parse a finite positive number, convert with `Math.round(minutes * 60)`, and dispatch. Do not add global form state or a form library.

- [ ] **Step 4: Render the service block inside the existing bus row**

Use one local formatter:

```ts
function formatHeadway(seconds: number | null): string {
  return seconds === null ? "—" : `${(seconds / 60).toFixed(1)} min`;
}
```

Display `assigned / required` when required is available; show `—` before a target is set.

Deploy enablement is presentation-only and requires:

```text
bus row
active
not broken
assignedFleet == 0
requiredFleet != null
requiredFleet > 0
```

Backend remains authoritative if the snapshot changes before click.

- [ ] **Step 5: Pass callbacks from App.svelte**

Follow existing route actions; do not introduce a new context/store.

- [ ] **Step 6: Add minimal CSS**

Reuse existing route-row/button/input tokens. Add only layout/typography required for the compact service block.

- [ ] **Step 7: Run UI tests, check, and lint**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/App.svelte src/components/hud/panels/LinesPanel.svelte src/styles.css tests/ui
git commit -m "feat: control bus headway from lines panel"
```

---

### Task 6: Prove the player-visible loop and run regression verification

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Verifies the complete HPA-624 player path through the real browser runtime.
- Does not own schema documentation; all active v6 -> v7 wording belongs to Task 1.

- [ ] **Step 1: Add one focused Playwright smoke**

Reuse existing sandbox/build/route helpers:

```text
open/create sandbox
build/connect the minimum bus route fixture
save bus route
assert No fleet and Fleet 0 / — before target
set whole-minute target headway
assert required fleet is a positive integer
click Deploy <N> buses
assert Fleet N / N and Current is not —
pause/resume
assert clock advances after resume
```

Do not wait for a passenger trip, inspect exact bus pixels, or manufacture traffic load in E2E.

- [ ] **Step 2: Run focused E2E**

```bash
bun run test:e2e -- tests/e2e/smoke.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run complete Rust/TS verification**

```bash
cargo test --workspace
bun run test:unit
bun run check
bun run format:check
bun run lint
```

Expected: all commands PASS. If generated WASM is stale, use the repository's normal `ensure-wasm`/pre-script flow; do not commit unrelated generated churn unless normal build tooling requires it.

- [ ] **Step 4: Run full E2E once**

```bash
bun run test:e2e
```

Expected: PASS, including route editing, persistence, shuttle, traffic, and new headway/fleet smoke coverage.

- [ ] **Step 5: Final active-v7 inventory**

Run:

```bash
rg -n 'schema[- ]?v?6|schema.?6|cities-v6|caelum-city-saves-v6|SNAPSHOT_SCHEMA_VERSION.?=.?6' \
  crates src src-tauri tests docs/architecture.md
```

Any remaining matches in active code/tests/architecture are Task-1 misses and must be fixed before completion. Historical specs/plans are intentionally excluded from this check.

- [ ] **Step 6: Self-review against HPA-624 non-goals and clarified policies**

Final diff must contain none of:

```text
Metro headway fields/intents/UI
service-band arrays
timetable/departure-history storage
player-facing plus-one AssignVehicle control
vehicle withdrawal/reassignment
auto-resizing or headway re-spacing after route edits
holding/bunching logic
generic fleet/service manager classes
migration/fallback readers
new map-layer controls
```

Also verify the diff still **contains/preserves** the existing structural route-edit rebase and existing low-level `AssignVehicle` support.

- [ ] **Step 7: Commit smoke coverage**

```bash
git add tests/e2e/smoke.spec.ts
git commit -m "test: cover bus headway fleet loop"
```

## Plan self-review

- **Spec coverage:** Tasks 1-6 cover v7 as one direct break, zero-vehicle bus creation, unchanged Metro creation, current-path congestion-aware round trip, loop + shuttle reversal semantics, required/current headway, zero-fleet passenger exclusion, headway persistence, atomic deployment, unequal-loop + shuttle time spacing, runtime/UI wiring, existing edit rebase, existing `AssignVehicle`, and one real sandbox smoke.
- **Review-feedback closure:** Structural edit rebase is explicitly preserved; shuttle vectors cover empty and U-turn reversals; TypeScript is specified as an exact current-path step port; `AssignVehicle` remains off the player path but valid for core/tests; every active v6 assertion belongs to Task 1 rather than Task 6.
- **YAGNI check:** No Metro service plan, multi-period schedule, vehicle resizing/withdrawal, holding/bunching, departure history, fleet inventory, generic operations abstraction, migration, or pre-release hardening is introduced.
- **Type consistency:** Rust `target_headway_seconds`, `SetBusTargetHeadway`, and `DeployBusFleet` map to TS `targetHeadwaySeconds`, `setBusTargetHeadway`, and `deployBusFleet`.
- **Timing consistency:** Rust and TypeScript both walk `current_path` steps only. The shared semantic vectors are `600/300 -> 2`, `601/300 -> 3`, shuttle `302s`, and congested shuttle `402s`.
- **Authority check:** Rust alone mutates headway/fleet and charges cost. TypeScript only derives display metrics and dispatches intents.
