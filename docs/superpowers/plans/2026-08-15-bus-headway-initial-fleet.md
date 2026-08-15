# HPA-624 Bus Headway and Initial Fleet Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate bus route geometry from service operation by letting a new bus route exist with zero fleet, setting one target headway, deriving required fleet from current congestion-aware round-trip time, and atomically deploying an evenly time-spaced initial fleet from the existing Lines panel.

**Architecture:** Keep the authority in `caelum-core`: a bus-only `bus_service` module owns headway validation, live round-trip/fleet math, and initial deployment. Persist only `Route.targetHeadwaySeconds`; derive round-trip/required/current-headway values from the snapshot instead of caching them. TypeScript mirrors the small calculation only for display and sends two explicit Rust intents for mutation. Metro creation remains unchanged and no generic service-plan abstraction is introduced.

**Tech Stack:** Rust (`caelum-core`, serde), Svelte 5 + TypeScript, existing runtime/backend intent bridge, Vitest, Playwright, Bun, Tauri/IndexedDB persistence.

## Global Constraints

- Implement HPA-624 only; HPA-334 remains the coordination parent.
- Bus only: do not change Metro headway/service-plan behavior.
- New bus routes have zero vehicles; new Metro lines retain the current initial vehicle.
- Persist one required-nullable `targetHeadwaySeconds` on bus `Route` only.
- Snapshot/database namespace becomes v7 directly; do not add migration or compatibility code.
- Required fleet is `max(1, ceil(roundTripSeconds / targetHeadwaySeconds))`.
- Round-trip and spacing use the same congestion-adjusted road-step duration as live buses.
- Initial fleet deployment is one-shot from zero vehicles and atomic under `CostPolicy`.
- Do not add service bands, timetables, holding, bunching, fleet resizing/withdrawal/reassignment, depots, vehicle inventories, or generic scheduler/fleet/service-plan abstractions.

## File structure

**Create**

- `crates/caelum-core/src/bus_service.rs` — bus-only headway metrics, cursor placement, target mutation, and initial deployment.
- `src/domain/busService.ts` — presentation-only bus service metrics from a `GameState`.
- `crates/caelum-core/tests/bus_service.rs` — end-to-end core behavior around zero fleet, headway, deployment, cost, spacing, and router eligibility.

**Modify**

- `crates/caelum-core/src/lib.rs` — register the `bus_service` module.
- `crates/caelum-core/src/model.rs` — schema v7 and `Route.target_headway_seconds`.
- `crates/caelum-core/src/intent.rs` — `SetBusTargetHeadway` and `DeployBusFleet`.
- `crates/caelum-core/src/engine.rs` — dispatch the two bus-service intents.
- `crates/caelum-core/src/route_editor.rs` — bus creation inserts zero vehicles; Metro creation remains current behavior.
- `crates/caelum-core/src/preview.rs` — new bus preview has zero initial vehicle cost; Metro preview remains current behavior.
- `crates/caelum-core/src/router.rs` — zero-fleet bus routes are not passenger services.
- `crates/caelum-core/src/rejection.rs` — `InvalidHeadway`, `HeadwayNotSet`, `FleetAlreadyAssigned`.
- `crates/caelum-core/src/transit.rs` — expose/reuse the existing per-step bus timing helper needed by `bus_service`; do not move vehicle ticking.
- `crates/caelum-core/tests/model_wire_format.rs` — v7 route wire contract.
- `crates/caelum-core/tests/route_editing.rs` — bus create/Metro create and preview behavior.
- `crates/caelum-core/tests/economy_cost_policy.rs` — zero-cost bus creation and atomic fleet cost.
- `crates/caelum-core/tests/transit_router.rs` — zero-fleet bus route exclusion.
- Rust fixture/construction files that instantiate `Route` directly — add `target_headway_seconds: None` rather than a compatibility default.
- `src/domain/types.ts` — schema v7, route field, new rejection codes.
- `src/domain/traffic.ts` — expose one pure congestion multiplier/flow lookup helper used by display metrics; keep constants unchanged.
- `src/runtime/backend/types.ts` — two new intent variants; bus preview keeps existing response shape with cost `0`.
- `src/runtime/types.ts` — bus-service row state and runtime controller methods.
- `src/runtime/createGameRuntime.ts` — dispatch headway/deployment commands.
- `src/runtime/runtimeSelectors.ts` — derive bus service row state and `noFleet` status.
- `src/runtime/rejectionMessages.ts` — user-facing messages for new rejection codes.
- `src/components/hud/panels/LinesPanel.svelte` — compact target/current/fleet controls in existing bus rows.
- `src/App.svelte` — pass runtime callbacks to LinesPanel.
- `src/styles.css` — minimal layout for the service block.
- `src/persistence/indexedDbCitySaveStore.ts` — v7 browser namespace.
- `src-tauri/src/city_store.rs` — `cities-v7` native namespace.
- `tests/fixtures/rustSnapshot.ts` and snapshot fixtures — v7 + required nullable bus route field.
- `tests/runtime/runtimeSelectors.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/ui/linesPanel.test.ts`, `tests/ui/appShell.test.ts` — runtime/UI coverage.
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` and native city-store tests — v7 namespace expectations.
- `tests/e2e/smoke.spec.ts` — one real bus create → headway → deploy flow.
- `docs/architecture.md` — update only existing schema-version wording if it names v6.

---

### Task 1: Make bus route creation fleet-free and bump the route wire contract to v7

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/route_editor.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: `crates/caelum-core/tests/route_editing.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: direct Rust `Route { ... }` fixtures reported by `cargo test -p caelum-core --no-run`
- Modify: `src/domain/types.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Modify: existing native city-store schema/namespace assertions

**Interfaces:**
- Produces: Rust `Route.target_headway_seconds: Option<u32>` serialized as required `targetHeadwaySeconds: number | null`.
- Produces: schema version `7` everywhere.
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

In preview tests, assert a new bus route reports `initial_vehicle_cost == 0` and does not receive an insufficient-budget rejection solely for bus purchase, while the equivalent Metro preview still reports `METRO_COST`.

- [ ] **Step 2: Run focused tests and confirm the old coupling fails**

Run:

```bash
cargo test -p caelum-core --test model_wire_format --test route_editing --test economy_cost_policy
```

Expected before implementation: failures around schema version/required field and bus creation still inserting/charging one vehicle.

- [ ] **Step 3: Add the required nullable route field and direct v7 break**

In Rust:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 7;

pub struct Route {
    // existing fields...
    #[serde(deserialize_with = "deserialize_required_option")]
    pub target_headway_seconds: Option<u32>,
}
```

In TypeScript:

```ts
export const SNAPSHOT_SCHEMA_VERSION = 7 as const;

export interface Route {
  // existing fields...
  targetHeadwaySeconds: number | null;
}
```

Update default storage names directly:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v7";
const DATABASE_VERSION = 7;
```

```rust
const CITY_DIRECTORY: &str = "cities-v7";
```

Every engine-created bus route starts with `target_headway_seconds: None`. Update direct test fixtures with the same explicit field; do not add `#[serde(default)]` to accept old route payloads.

- [ ] **Step 4: Decouple only bus creation from the initial vehicle**

Change `insert_route` to accept the concrete vehicle-id vector rather than a mandatory single ID:

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
    // Bus Route uses vehicle_ids and target_headway_seconds: None.
    // MetroLine uses vehicle_ids unchanged from current semantics.
}
```

In `create_route_costed`, create/charge the initial vehicle only for `TransitMode::Metro`. For `TransitMode::Bus`, use a zero nominal vehicle cost, insert `vehicle_ids: vec![]`, and do not push a vehicle.

Make `preview_route` use the same mode-specific creation-cost rule:

```rust
let initial_vehicle_cost = if request.route_id.is_none() && request.mode == TransitMode::Metro {
    transit::vehicle_cost(TransitMode::Metro)
} else {
    0
};
```

- [ ] **Step 5: Compile to find every direct Route fixture, then make the wire break explicit**

Run:

```bash
cargo test -p caelum-core --no-run
bun run check
```

For each compiler-reported Rust `Route { ... }` fixture, add exactly:

```rust
target_headway_seconds: None,
```

For each TS fixture representing a bus route, add exactly:

```ts
targetHeadwaySeconds: null,
```

Do not add a fallback constructor or compatibility normalizer just to hide the v7 break.

- [ ] **Step 6: Run the focused + persistence contract tests**

Run:

```bash
cargo test -p caelum-core --test model_wire_format --test route_editing --test economy_cost_policy
bun run test:unit -- tests/runtime/persistence/indexedDbCitySaveStore.test.ts
```

Expected: PASS with bus creation fleet-free and Metro behavior unchanged.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core src src-tauri tests docs/architecture.md
git commit -m "feat: separate bus route creation from fleet"
```

---

### Task 2: Add bus-only live headway/fleet math and exclude zero-fleet routes from passenger planning

**Files:**
- Create: `crates/caelum-core/src/bus_service.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/router.rs`
- Create: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/tests/transit_router.rs`

**Interfaces:**
- Produces: `bus_service::BusServiceMetrics`.
- Produces: `bus_service::metrics(route, flow) -> Option<BusServiceMetrics>`.
- Produces: `bus_service::required_fleet(round_trip_seconds, target_headway_seconds) -> usize`.
- Reuses: `traffic::effective_road_step_seconds` through the same per-step vehicle timing seam as `tick_vehicles`.

Use this concrete Rust shape:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct BusServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub current_headway_seconds: Option<f64>,
}
```

- [ ] **Step 1: Write failing service-math and router tests**

Cover three vectors:

```text
round trip 600s, target 300s -> required 2
round trip 601s, target 300s -> required 3
round trip 600s, target unset -> required None
```

Build one route with two unequal road legs (for example effective durations 100s and 300s plus the remaining cyclic leg duration) and assert round-trip is the sum of actual effective road-step durations, not stop count.

Build a flow map that raises one road step's multiplier and assert the resulting round-trip/required fleet changes predictably.

In `transit_router.rs`, create an active connected bus route with `vehicle_ids = []` and assert `find_route_plan` does not return that line; add one bus and assert the service becomes eligible.

- [ ] **Step 2: Run the new tests and confirm failures**

```bash
cargo test -p caelum-core --test bus_service --test transit_router
```

Expected before implementation: missing `bus_service` API and zero-fleet bus still appears in `active_services`.

- [ ] **Step 3: Share the live per-step timing seam, not a second congestion formula**

Rename/expose the existing private helper in `transit.rs` as crate-visible:

```rust
pub(crate) fn vehicle_step_seconds(
    flow: &RoadFlow,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64
```

Keep its implementation unchanged: buses use `traffic::effective_road_step_seconds`; other modes use stored step time.

- [ ] **Step 4: Implement bus round-trip and required/current headway derivation**

In `bus_service.rs`, sum the route's cyclic `legs` by actual path steps:

```rust
fn bus_round_trip_seconds(route: &Route, flow: &RoadFlow) -> Option<f64> {
    let mut total = 0.0;
    for leg in &route.legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            total += crate::transit::vehicle_step_seconds(flow, TransitMode::Bus, step);
        }
    }
    (total > 0.0 && total.is_finite()).then_some(total)
}

pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize {
    ((round_trip_seconds / f64::from(target_headway_seconds)).ceil() as usize).max(1)
}
```

`metrics` reads `route.target_headway_seconds`, uses `route.vehicle_ids.len()` for assigned fleet, and returns `round_trip / assigned` only when assigned is non-zero.

- [ ] **Step 5: Gate passenger routing on actual bus fleet**

In `router::active_services`, keep the existing structural check and add only:

```rust
if route.vehicle_ids.is_empty() {
    continue;
}
```

Do not change `is_route_operational`, because fleet assignment must be allowed while a route has zero vehicles.

- [ ] **Step 6: Run focused tests**

```bash
cargo test -p caelum-core --test bus_service --test transit_router --test router_planning --test router_estimate_branches
```

Expected: PASS; congestion-aware math and passenger eligibility are deterministic.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/bus_service.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/router.rs crates/caelum-core/tests/bus_service.rs crates/caelum-core/tests/transit_router.rs
git commit -m "feat: derive bus headway fleet metrics"
```

---

### Task 3: Add authoritative headway setting and atomic deterministic initial fleet deployment

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-core/src/bus_service.rs`
- Modify: `crates/caelum-core/tests/bus_service.rs`
- Modify: `crates/caelum-core/tests/economy_cost_policy.rs`
- Modify: `crates/caelum-core/tests/engine_smoke.rs`

**Interfaces:**
- Produces wire intents:

```rust
SetBusTargetHeadway { route_id: String, target_headway_seconds: u32 }
DeployBusFleet { route_id: String }
```

- Produces rejection codes: `InvalidHeadway`, `HeadwayNotSet`, `FleetAlreadyAssigned`.
- Deployment uses `BUS_COST`, `CostPolicy`, `initial_vehicle`, and Task 2 service metrics.

- [ ] **Step 1: Add failing dispatch tests**

Add tests that assert:

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

Also assert headway `0` returns `InvalidHeadway`, deploying without a target returns `HeadwayNotSet`, and a second deployment returns `FleetAlreadyAssigned` without changing budget/vehicles.

For Standard economy, set budget to exactly `required * BUS_COST` and assert it reaches zero after one deployment. Repeat one unit below the cost and assert `InsufficientBudget` with zero buses added. In Creative, assert the same fleet is created with budget unchanged.

- [ ] **Step 2: Add a failing unequal-leg spacing assertion**

Use a route whose effective cycle is 400 seconds with `N = 2`. Assert vehicle 0 starts at offset 0 and vehicle 1 resolves to the cursor containing offset 200, which must land inside the longer leg rather than simply at “stop 2”.

Assert stable vehicle IDs and cursors across two identical source snapshots.

- [ ] **Step 3: Run the focused tests**

```bash
cargo test -p caelum-core --test bus_service --test economy_cost_policy --test engine_smoke
```

Expected before implementation: missing intents/rejections/deployment.

- [ ] **Step 4: Implement headway mutation**

In `bus_service.rs`:

```rust
pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    route_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot>
```

Reject zero with `InvalidHeadway`, reject non-bus IDs with `RouteNotFound`, clone once, set `target_headway_seconds`, and return unchanged state if the value is identical. Do not touch route revision or vehicles.

- [ ] **Step 5: Implement a pure time-offset-to-cursor helper**

Use a concrete cursor shape local to `bus_service.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
struct ServiceCursor {
    itinerary_index: usize,
    path_step_index: usize,
    step_progress: f64,
}
```

Walk legs and their steps in itinerary order. For each effective step duration `d`:

```text
if remaining < d:
    progress = remaining / d
    return current cursor
else:
    remaining -= d
```

Skip `d <= 0`. Offsets passed by deployment are always below total cycle time.

- [ ] **Step 6: Implement atomic initial deployment**

In `deploy_initial_fleet`:

1. locate the bus route;
2. require `active` and all connected legs;
3. require target headway;
4. require `vehicle_ids.is_empty()`;
5. derive `RoadFlow` once with `traffic::derive_road_flow(state)`;
6. derive current metrics and `required_fleet` once;
7. authorize `required_fleet as i32 * BUS_COST` before mutating the candidate;
8. clone the snapshot;
9. create buses in index order with `initial_vehicle` against the growing candidate;
10. set each new vehicle cursor from `round_trip * i / required_fleet`;
11. push IDs onto the route and vehicles into the network;
12. apply the authorized cost once;
13. return `CostedMutation::new(candidate)`.

Do not call `assign_vehicle_costed` in a loop and do not partially commit affordable buses.

- [ ] **Step 7: Dispatch the intents in `GameEngine` and serialize them**

Add direct match arms that follow existing gameplay mutation handling. Do not add a second command channel.

- [ ] **Step 8: Prove live movement stays deterministic after spaced deployment**

Add one regression that clones the deployed snapshot, advances one copy by a coarse tick and the other by equivalent fine ticks, then compares bus cursor state. Use the existing HPA-622 road-flow timing path rather than a mocked scheduler.

Run:

```bash
cargo test -p caelum-core --test bus_service --test economy_cost_policy --test engine_smoke --test golden_sequences
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core/src crates/caelum-core/tests
git commit -m "feat: deploy bus fleet from target headway"
```

---

### Task 4: Mirror service metrics for presentation and wire runtime commands

**Files:**
- Create: `src/domain/busService.ts`
- Modify: `src/domain/traffic.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/rejectionMessages.ts`
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

- [ ] **Step 1: Write failing TS metric and selector tests**

Use the same representative vectors as Rust: 600/300 -> 2 fleet, 601/300 -> 3 fleet, a congested road step changes round-trip, zero fleet produces `currentHeadwaySeconds: null`.

Add selector expectations:

```ts
expect(row.status.primary).toBe("noFleet");
expect(row.busService).toMatchObject({
  targetHeadwaySeconds: 300,
  assignedFleet: 0,
  requiredFleet: 2,
  currentHeadwaySeconds: null,
});
```

After adding two vehicle IDs, assert status `running` and current headway equals `roundTrip / 2`.

- [ ] **Step 2: Run focused TS tests**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/gameRuntime.test.ts
```

Expected before implementation: missing field/helper/controller commands.

- [ ] **Step 3: Implement the presentation-only bus metric helper**

In `traffic.ts`, export the same simple multiplier already implied by the overlay constants:

```ts
export function congestionMultiplier(flow: number): number {
  return Math.min(
    MAX_CONGESTION_MULTIPLIER,
    Math.max(1, flow / ROAD_FLOW_CAPACITY),
  );
}
```

In `busService.ts`, build a point->flow map from `selectTrafficFlow(state)`, sum every road path step on `route.legs`, and apply the exact formula from the design. Zero-step paths contribute zero.

This file must not mutate state or dispatch intents.

- [ ] **Step 4: Extend runtime/backend contracts**

Add intent variants:

```ts
| {
    type: "setBusTargetHeadway";
    routeId: string;
    targetHeadwaySeconds: number;
  }
| { type: "deployBusFleet"; routeId: string }
```

Add `"invalidHeadway" | "headwayNotSet" | "fleetAlreadyAssigned"` to `RejectionCode`.

Add `ShellBusServiceState` and optional `busService` to bus route rows; Metro rows use `busService: null`.

Add `noFleet` to `RouteServiceStatus.primary`.

- [ ] **Step 5: Wire controller methods through the existing serialized dispatch path**

In `createGameRuntime.ts`, follow the same pattern as route rename/toggle:

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

Use the file's existing dispatch helper names exactly as implemented there; do not create a parallel queue or optimistic local mutation.

- [ ] **Step 6: Derive row status/service metrics and rejection copy**

Status precedence in `runtimeSelectors.ts`:

```text
broken -> paused -> noFleet(bus only) -> running
```

Add concise rejection messages:

```text
invalidHeadway -> "Headway must be greater than zero."
headwayNotSet -> "Set a target headway before deploying buses."
fleetAlreadyAssigned -> "This route already has its initial fleet."
```

Budget rejection continues to use the existing generic budget message.

- [ ] **Step 7: Run focused runtime tests and check types**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/gameRuntime.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain src/runtime tests/runtime
git commit -m "feat: expose bus service controls to runtime"
```

---

### Task 5: Add the compact Lines-panel service-control loop

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

For a bus row with zero fleet, assert the DOM contains:

```text
No fleet
Target
Current
Fleet
0 / <required>
Set
Deploy <required> buses
```

Assert entering `6` in the minutes input and pressing Set invokes:

```ts
onSetBusTargetHeadway(route.id, 360)
```

Assert Deploy invokes `onDeployBusFleet(route.id)`. Assert Metro rows render none of these bus-service controls.

- [ ] **Step 2: Run the UI tests**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Expected before implementation: missing controls/callbacks.

- [ ] **Step 3: Add local headway-minute draft state in LinesPanel**

Use the same route-keyed local-draft style as route names:

```ts
let headwayMinuteDrafts = $state<Record<string, string>>({});
```

Initialize the displayed value from `targetHeadwaySeconds / 60` when no local draft exists. On Set, parse a finite positive number of minutes, convert with `Math.round(minutes * 60)`, and call the runtime callback. Do not add form libraries or global UI state.

- [ ] **Step 4: Render the bus service block inside the existing route row**

Keep labels compact. Format seconds with one helper such as:

```ts
function formatHeadway(seconds: number | null): string {
  return seconds === null ? "—" : `${(seconds / 60).toFixed(1)} min`;
}
```

Display assigned/required as `assigned / required` when target metrics exist; show `—` for required before a target is set.

The deploy button is enabled only when:

```text
route.mode == bus
route.active
route.status.primary != broken
assignedFleet == 0
requiredFleet != null
requiredFleet > 0
```

The backend remains authoritative and may still reject a stale click.

- [ ] **Step 5: Pass the two runtime callbacks from App.svelte**

Follow the existing route action callbacks; do not introduce a new context/store.

- [ ] **Step 6: Add minimal CSS using the existing route-row tokens**

Add only layout/typography needed for the service metrics/input/action. Reuse existing button/input variables and route-row spacing; do not extract a design-system component.

- [ ] **Step 7: Run UI tests, check, and lint the touched UI**

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

### Task 6: Prove the player-visible loop and run the full regression suite

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/architecture.md` only if schema-v6 wording remains after Task 1

**Interfaces:**
- Verifies the complete HPA-624 path through the real browser runtime.

- [ ] **Step 1: Add one focused Playwright smoke**

Reuse the existing sandbox/build/route helpers in `smoke.spec.ts`. The test flow is:

```text
open/create sandbox
build/connect the minimum bus route fixture already used by existing route smoke coverage
save bus route
assert route row says No fleet and Fleet 0 / — (before target)
set a whole-minute target headway
assert required fleet becomes a positive integer
click Deploy <N> buses
assert Fleet N / N and Current is not —
pause/resume
assert the game clock advances after resume
```

Do not wait for a passenger trip or create a congestion scenario in E2E.

- [ ] **Step 2: Run the focused E2E**

```bash
bun run test:e2e -- tests/e2e/smoke.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run complete Rust, TS, formatting, and lint verification**

```bash
cargo test --workspace
bun run test:unit
bun run check
bun run format:check
bun run lint
```

Expected: all commands PASS. If generated WASM is stale, use the repository's existing `bun run ensure-wasm`/pre-script flow; do not commit unrelated generated churn unless the repo's normal build requires it.

- [ ] **Step 4: Run the full E2E suite once**

```bash
bun run test:e2e
```

Expected: PASS, including existing route editing, persistence, and traffic smoke coverage.

- [ ] **Step 5: Self-review against HPA-624 non-goals**

The final diff must contain **none** of the following: Metro headway fields/intents/UI, service-band arrays, timetable/departure-history storage, vehicle withdrawal/reassignment, auto-resizing, holding/bunching logic, generic fleet/service manager classes, migration/fallback readers, or new map-layer controls.

- [ ] **Step 6: Commit final verification/docs adjustments**

```bash
git add tests/e2e/smoke.spec.ts docs/architecture.md
git commit -m "test: cover bus headway fleet loop"
```

## Plan self-review

- **Spec coverage:** Tasks 1-6 cover the direct v7 wire break, zero-vehicle bus creation, mode-specific preview cost, live congestion-aware round-trip calculation, required/current headway, zero-fleet passenger exclusion, headway persistence, atomic initial deployment, unequal-leg deterministic spacing, runtime/UI wiring, and one real sandbox smoke.
- **YAGNI check:** Metro service plans, multi-period schedules, vehicle resizing/withdrawal, holding/bunching, departure history, fleet inventories, generic operations abstractions, migration, and pre-release hardening are explicitly absent.
- **Type consistency:** Rust wire names `target_headway_seconds`, `SetBusTargetHeadway`, and `DeployBusFleet` map to TS `targetHeadwaySeconds`, `setBusTargetHeadway`, and `deployBusFleet`; required-fleet formula and `noFleet` semantics are identical across core and presentation selectors.
- **Authority check:** Rust alone mutates headway/fleet and charges cost. TypeScript only derives display metrics and dispatches intents.
