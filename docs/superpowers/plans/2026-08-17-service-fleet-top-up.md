# HPA-628 Post-Deployment Fleet Top-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an already-deployed Bus or Metro service buy exactly one additional vehicle when Rust's current required fleet exceeds its assigned fleet, inserting that vehicle into the largest current service gap without moving the existing fleet.

**Architecture:** `service_control` remains the product/domain authority: resolve the line, recompute live cycle/required fleet, publish one Rust-owned top-up offer, and choose the new vehicle's deterministic insertion cursor. Reuse the existing one-vehicle purchase/append path by extracting a typed core from `transit::assign_vehicle_costed`; do not create a second Bus/Metro append implementation. TypeScript forwards the derived offer and renders one button.

**Tech Stack:** Rust `caelum-core`, serde wire contracts, TypeScript runtime, Svelte, Vitest, Playwright.

## Global Constraints

- Product command is `{ type: "addServiceVehicle", lineId }`; never add player-facing `mode`.
- `AssignVehicle` remains a low-level test/dev seam.
- One click buys exactly one vehicle; no bulk or automatic resize.
- Existing vehicles are never moved, re-spaced, parked, or unloaded by top-up.
- New vehicle insertion uses the midpoint of the largest current travel-time gap; do not blindly use cursor 0.
- `nextVehicleCost` is Rust-derived output only; production TypeScript owns no vehicle price or fleet formula.
- The Lines button is rendered iff `nextVehicleCost !== null`; TypeScript does not repeat Rust's availability predicate.
- Standard charges one vehicle cost; Creative deducts zero.
- Zero-fleet/no-target state is unchanged; initial deployment remains `DeployInitialFleet`.
- A stale click at/above the live requirement is unchanged (`applied == false`), not a new rejection family.
- No withdrawal/refund/reassignment, post-deployment target editing, measured headway history, diagnostics framework, bunching/holding, schema bump, migration, or compatibility layer.

---

## Baseline gate

Remote `main` already contains HPA-626. PR #47 was opened before that merge, so rebase the implementation branch before touching code.

```bash
git fetch origin
git rebase origin/main

test -f crates/caelum-core/src/service_control.rs
! test -f crates/caelum-core/src/bus_service.rs
rg "SetServiceTargetHeadway|DeployInitialFleet" crates/caelum-core/src/intent.rs
rg "pub struct ServiceMetrics" crates/caelum-core/src/model.rs
rg "estimated_deployment_cost" crates/caelum-core/src/model.rs crates/caelum-core/src/service_control.rs
rg "Target|Nominal|Fleet" src/components/hud/panels/LinesPanel.svelte
```

Run the baseline:

```bash
cargo test --workspace
bun run test:unit
bun run check
```

If these symbols do not describe the checked-out branch, stop and rebase/fix the branch. Do not recreate the older Bus-only `bus_service` API.

## Risks

- **Broad fixture seam:** `AssignVehicle` is used throughout core tests. The extraction in Task 1 gets a full `cargo test -p caelum-core` gate before feature work.
- **Placement scope creep:** largest-gap midpoint is the only placement improvement. Do not move the existing fleet or build a scheduler/optimizer.
- **Planning branch age:** PR #47's historical base SHA predates HPA-626; implementation must use current remote `main`, not the branch's old ancestry.

---

### Task 1: Extract the typed one-vehicle append core without changing behavior

**Files:**
- Modify: `crates/caelum-core/src/transit.rs`
- Modify only for focused unit coverage if useful: `crates/caelum-core/src/transit.rs` test module

**Interfaces:**
- Produces: `transit::append_vehicle_costed(state: &GameSnapshot, vehicle: Vehicle) -> GameplayResult<CostedMutation>`.
- Preserves: `assign_vehicle_costed(state, mode: &str, line_id)` and every existing `GameIntent::AssignVehicle` behavior.

- [ ] **Step 1: Refactor `assign_vehicle_costed` to keep string parsing only at the edge**

Target shape:

```rust
pub(crate) fn assign_vehicle_costed(
    state: &GameSnapshot,
    mode: &str,
    line_id: &str,
) -> GameplayResult<CostedMutation> {
    let mode = match mode {
        "bus" => TransitMode::Bus,
        "metro" => TransitMode::Metro,
        _ => {
            return Err(route_rejection(
                RejectionCode::IncompatibleRouteNode,
                line_id,
            ));
        }
    };
    let vehicle = initial_vehicle(state, mode, line_id);
    append_vehicle_costed(state, vehicle)
}
```

- [ ] **Step 2: Move the existing paid append into a typed helper**

Add:

```rust
pub(crate) fn append_vehicle_costed(
    state: &GameSnapshot,
    vehicle: Vehicle,
) -> GameplayResult<CostedMutation> {
    let mode = vehicle.mode;
    let line_id = vehicle.line_id.clone();
    let vehicle_id = vehicle.id.clone();

    // Preserve current AssignVehicle ordering: authorize before route lookup.
    let authorized = CostPolicy::from_snapshot(state)
        .quote(vehicle_cost(mode), state.budget)
        .authorize()?;

    let mut next = state.clone();
    match mode {
        TransitMode::Bus => {
            let route = next
                .transit
                .routes
                .iter_mut()
                .find(|route| route.id == line_id)
                .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, &line_id))?;
            if !route.active {
                return Err(route_rejection(RejectionCode::InactiveRoute, &line_id));
            }
            if !is_route_operational(route.active, &route.legs) {
                return Err(route_rejection(RejectionCode::DisconnectedLeg, &line_id));
            }
            route.vehicle_ids.push(vehicle_id);
        }
        TransitMode::Metro => {
            let line = next
                .transit
                .metro_lines
                .iter_mut()
                .find(|line| line.id == line_id)
                .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, &line_id))?;
            if !line.active {
                return Err(route_rejection(RejectionCode::InactiveRoute, &line_id));
            }
            if !is_route_operational(line.active, &line.legs) {
                return Err(route_rejection(RejectionCode::DisconnectedLeg, &line_id));
            }
            line.vehicle_ids.push(vehicle_id);
        }
        TransitMode::Walk => {
            return Err(route_rejection(
                RejectionCode::IncompatibleRouteNode,
                &line_id,
            ));
        }
    }

    next.transit.vehicles.push(vehicle);
    authorized.apply_to(&mut next.budget)?;
    Ok(CostedMutation::new(next))
}
```

Do not use an `else => Metro` branch. The exhaustive match is the guard against `Walk` or a future mode silently entering Metro storage.

- [ ] **Step 3: Run the full core regression gate**

```bash
cargo fmt --all --check
cargo test -p caelum-core
```

Expected: all existing tests pass before any HPA-628 behavior is added.

- [ ] **Step 4: Commit**

```bash
git add crates/caelum-core/src/transit.rs
git commit -m "refactor: share typed vehicle append mutation"
```

---

### Task 2: Add the authoritative top-up offer, insertion placement, and Rust intent

**Files:**
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`

**Interfaces:**
- Consumes: `transit::append_vehicle_costed` from Task 1.
- Produces: `GameIntent::AddServiceVehicle { line_id: String }`.
- Produces: `service_control::add_service_vehicle(state, line_id)`.
- Produces: `ServiceMetrics.next_vehicle_cost: Option<i32>` / wire `nextVehicleCost`.

- [ ] **Step 1: Write a failing Bus top-up test with at least two existing vehicles**

Extend the existing `tests/service_control.rs` fixture.

Use a route whose cycle is greater than the 60-second floor and pick a target that yields an initial required fleet of at least two:

```rust
let cycle = engine.snapshot().transit.routes[0]
    .service_metrics.as_ref().unwrap().round_trip_seconds;
assert!(cycle > 60.0, "fixture must support a multi-vehicle fleet");
let target = ((cycle / 2.0).ceil() as u32).max(60);

assert!(engine.dispatch(GameIntent::SetServiceTargetHeadway {
    line_id: "route-001".into(),
    target_headway_seconds: target,
}).applied);
assert!(engine.dispatch(GameIntent::DeployInitialFleet {
    line_id: "route-001".into(),
}).applied);
assert!(
    engine.snapshot().transit.routes[0]
        .service_metrics.as_ref().unwrap().assigned_fleet >= 2
);
```

Create the shortfall without `UpdateRoute`: take `snapshot_for_save()`, multiply every current Bus road-step `travel_seconds` by `2.0`, update each path's stored total, restore, and assert `requiredFleet > assignedFleet`.

Capture all existing vehicles before top-up.

Dispatch the future intent and prove:

- exactly one new vehicle;
- new mode is Bus and capacity is `BUS_CAPACITY`;
- all pre-existing cursor fields, `parked_position`, and `passenger_ids` are unchanged;
- new cursor is different from every existing cursor in this controlled spaced fixture.

Expected initially: compile failure because `AddServiceVehicle` does not exist.

- [ ] **Step 2: Add the line-ID-only intent and engine dispatch**

`intent.rs`:

```rust
AddServiceVehicle {
    line_id: String,
},
```

`engine.rs`:

```rust
GameIntent::AddServiceVehicle { line_id } => self.commit_result(
    crate::service_control::add_service_vehicle(&self.snapshot, &line_id),
),
```

No `mode` on the product command.

- [ ] **Step 3: Add one shared Rust availability helper**

In `service_control.rs` add:

```rust
fn top_up_offer(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32> {
    if !active || !is_route_operational(active, legs) || assigned_fleet == 0 {
        return None;
    }
    required_fleet
        .filter(|required| assigned_fleet < *required)
        .map(|_| vehicle_cost(mode))
}
```

This is the one fleet-shortfall/offer predicate used by both derived metrics and the authoritative mutation.

- [ ] **Step 4: Add cursor-to-cycle-offset and largest-gap placement helpers**

Keep these private to `service_control.rs`.

Add a helper that maps an existing vehicle cursor to elapsed current-cycle seconds using `vehicle_step_seconds` for every preceding step plus the current step's `step_progress`.

Handle a zero-step terminal-reversal leg at its accumulated leg-start offset.

Then add a placement helper with this behavior:

```text
existing vehicle offsets -> sort ascending
for each adjacent pair, compute gap
include wrap gap: last -> roundTrip -> first
take largest gap; ties keep earliest start
insert at start + gap/2, modulo roundTrip
resolve_service_cursor(...) -> ServiceCursor
```

Do not move existing vehicles.

Add focused unit tests next to these private helpers:

- two evenly spaced vehicles choose the deterministic first gap midpoint;
- one vehicle chooses half-cycle;
- wrap-around gap participates;
- equal-gap tie-breaking is deterministic.

- [ ] **Step 5: Implement `add_service_vehicle`**

Flow:

```text
resolve Bus/Metro
read active, legs, target, assigned fleet
if assigned == 0 or target absent -> unchanged
if inactive -> InactiveRoute
if structurally broken -> DisconnectedLeg
if forged target < MIN_HEADWAY_SECONDS -> InvalidHeadway
derive current RoadFlow
recompute roundTripSeconds
recompute requiredFleet
call top_up_offer(...)
if None -> unchanged
compute largest-gap midpoint cursor
create vehicle with initial_vehicle
replace only new vehicle cursor with midpoint
call append_vehicle_costed(state, vehicle)
```

Important ordering: the product path validates service state before entering `append_vehicle_costed`. Therefore inactive/disconnected service errors win over budget errors for `AddServiceVehicle`. Keep the low-level `AssignVehicle` ordering unchanged from Task 1.

- [ ] **Step 6: Add the cost, stale-action, and mode-parity proofs**

In `tests/service_control.rs` add focused tests for:

- Standard budget decreases by exactly one `BUS_COST`/`METRO_COST`;
- Creative budget is unchanged;
- insufficient Standard budget appends no vehicle and changes no budget;
- zero fleet is unchanged and does not replace `DeployInitialFleet`;
- at-target action is unchanged;
- repeated/stale actions cannot buy beyond the live requirement;
- inactive deployed service -> `InactiveRoute`;
- disconnected deployed service -> `DisconnectedLeg`;
- missing line -> `RouteNotFound`;
- Metro shortfall adds one Metro vehicle by line ID.

Use timing-fixture changes for preservation/recompute tests. Do not use `UpdateRoute` there.

- [ ] **Step 7: Publish `nextVehicleCost` from the same offer helper**

Add to `ServiceMetrics`:

```rust
pub next_vehicle_cost: Option<i32>,
```

Pass `active` into `metrics(...)`; no generic route trait is needed.

After deriving `required_fleet`, compute:

```rust
let next_vehicle_cost = top_up_offer(
    active,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Keep `estimated_deployment_cost` unchanged for zero-fleet setup.

Add metric regressions:

- active operational deployed shortfall -> Rust vehicle cost;
- before deployment -> null;
- at target -> null;
- paused -> null;
- broken -> null;
- Bus and Metro prices are correct.

- [ ] **Step 8: Extend wire and save-contract tests**

Assert intent JSON:

```json
{
  "type": "addServiceVehicle",
  "lineId": "route-001"
}
```

Assert no `mode` key.

Assert output `serviceMetrics` carries camelCase `nextVehicleCost` and `snapshot_for_save()` still omits `serviceMetrics` entirely.

- [ ] **Step 9: Run the Rust feature gate**

```bash
cargo fmt --all --check
cargo test -p caelum-core
```

- [ ] **Step 10: Commit**

```bash
git add crates/caelum-core/src/service_control.rs \
        crates/caelum-core/src/model.rs \
        crates/caelum-core/src/intent.rs \
        crates/caelum-core/src/engine.rs \
        crates/caelum-core/tests/service_control.rs \
        crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat: add service fleet top-up"
```

---

### Task 3: Publish the new derived field and runtime command to TypeScript

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify only if full metric objects require it: `tests/helpers/gameState.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify only if exhaustive intent fixtures require it: `tests/runtime/tauriBackend.test.ts`

**Interfaces:**
- Consumes: Rust `nextVehicleCost` and `AddServiceVehicle` wire contract.
- Produces: `RuntimeController.addServiceVehicle(lineId)`.

- [ ] **Step 1: Add the TypeScript metric field and intent union**

In the canonical `ServiceMetrics` type:

```ts
nextVehicleCost: number | null;
```

In backend `GameIntent`:

```ts
| { type: "addServiceVehicle"; lineId: string }
```

Update canonical Rust snapshot fixtures. Do not add `BUS_COST`, `METRO_COST`, required-fleet math, or a fallback price in TypeScript.

- [ ] **Step 2: Add the thin runtime method**

`RuntimeController`:

```ts
addServiceVehicle: (lineId: string) => RuntimeCommandResult;
```

`createGameRuntime.ts`:

```ts
addServiceVehicle(lineId) {
  if (dead) return Promise.resolve(getSnapshot());
  return enqueueDispatch({ type: "addServiceVehicle", lineId });
},
```

Runtime test must assert the backend receives exactly:

```ts
{ type: "addServiceVehicle", lineId: "metro-001" }
```

and no `mode`.

- [ ] **Step 3: Verify and commit**

```bash
bunx vitest run tests/runtime/gameRuntime.test.ts tests/runtime/tauriBackend.test.ts
bun run check

git add src/domain/types.ts \
        src/runtime/backend/types.ts \
        src/runtime/types.ts \
        src/runtime/createGameRuntime.ts \
        tests/fixtures/rustSnapshot.ts \
        tests/runtime/gameRuntime.test.ts \
        tests/runtime/tauriBackend.test.ts
git commit -m "feat: dispatch service vehicle top-up"
```

Only stage files that actually changed.

---

### Task 4: Add the one-button Lines-row control

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify only if callback wiring is exhaustively asserted: `tests/ui/appShell.test.ts`

**Interfaces:**
- Consumes: `nextVehicleCost` and runtime command from Task 3.

- [ ] **Step 1: Forward the Rust offer without re-deriving it**

Add to `ShellServiceState`:

```ts
nextVehicleCost: number | null;
```

Selector:

```ts
nextVehicleCost: route.serviceMetrics?.nextVehicleCost ?? null,
```

Test direct forwarding. Do not compare `assignedFleet` and `requiredFleet` in TypeScript to decide availability.

- [ ] **Step 2: Add component tests**

Cover:

- Bus with non-null `nextVehicleCost`: button says `Add bus`, includes formatted cost, one click calls callback once;
- Metro with non-null `nextVehicleCost`: label says `Add train`;
- null `nextVehicleCost`: no add button, regardless of other fixture values.

Also keep fleet readout coverage (`assigned / required`) as presentation only.

- [ ] **Step 3: Render the action from the Rust offer only**

Add prop:

```ts
onAddServiceVehicle: (routeId: string) => void;
```

In the deployed row:

```svelte
{#if route.service.nextVehicleCost !== null}
  <button
    type="button"
    class="route-toggle"
    data-testid={`route-add-vehicle-${route.id}`}
    onclick={() => onAddServiceVehicle(route.id)}
  >
    {`Add ${route.mode === "metro" ? "train" : "bus"} · ${formatBudget(route.service.nextVehicleCost)}`}
  </button>
{/if}
```

No status/shortfall predicate in Svelte; Rust's `nextVehicleCost` already encodes it.

- [ ] **Step 4: Wire `App.svelte`**

```ts
function handleAddServiceVehicle(lineId: string): void {
  if (runtime !== null) {
    void applyRuntimeResult(() => runtime.addServiceVehicle(lineId));
  }
}
```

Pass it to `LinesPanel`.

- [ ] **Step 5: Verify and commit**

```bash
bunx vitest run tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check

git commit -m "feat: add fleet top-up control to Lines"
```

---

### Task 5: Prove the real route-edit recovery loop without predicting `ceil`

**Files:**
- Modify: `tests/e2e/routes.spec.ts`
- Modify an existing E2E helper only if necessary.

**Interfaces:**
- Consumes: authoritative Rust `serviceMetrics` after edit and after add.

- [ ] **Step 1: Extend an existing Bus scenario**

Sequence:

1. create a connected Bus route;
2. set target and deploy initial fleet;
3. record budget and assigned fleet;
4. edit the route to include a farther existing stop and save;
5. poll the **post-edit** runtime snapshot until `requiredFleet > assignedFleet`;
6. capture `postEditAssigned`, `postEditRequired`, `postEditNominal`, `nextVehicleCost`, and budget;
7. assert `nextVehicleCost !== null` and Add bus is visible;
8. click Add bus once;
9. poll until assigned fleet is `postEditAssigned + 1`;
10. assert Standard budget decreased by the captured Rust `nextVehicleCost`;
11. assert post-add nominal headway is less than post-edit nominal headway;
12. read post-add `nextVehicleCost` and assert button visibility matches it exactly:
    - null -> hidden;
    - non-null -> still visible.

Do **not** hardcode `requiredFleet == assignedFleet + 1`.

Do **not** assert cursor/passenger identity across `UpdateRoute`; route edit intentionally rebases vehicles. Task 2 owns preservation across the top-up mutation itself.

No second Metro E2E.

- [ ] **Step 2: Run and commit**

```bash
bunx playwright test tests/e2e/routes.spec.ts
git add tests/e2e/routes.spec.ts
git commit -m "test: cover service fleet top-up flow"
```

---

### Task 6: Full verification and scope scan

- [ ] **Step 1: Run repository gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run format:check
bun run check
bun run lint:svelte
bun run lint:css
bun run test:unit
bun run test:e2e
bun run build
```

- [ ] **Step 2: Check no product logic moved into TypeScript**

```bash
rg "BUS_COST|METRO_COST|8000|50000" src
rg "requiredFleet.*[/+*<>]|assignedFleet.*requiredFleet" src
```

Expected: no new production TS price/fleet-availability formula.

- [ ] **Step 3: Check scope boundaries**

```bash
rg "FleetManager|fleet manager|withdraw|refund|rebalance|bunch|holding|ServicePlan" \
  crates/caelum-core/src src
```

Review any new match. HPA-628 may contain largest-gap insertion only; it must not contain a fleet optimizer/rebalancer.

- [ ] **Step 4: Check persistence stayed unchanged**

```bash
rg "SNAPSHOT_SCHEMA_VERSION|caelum-city-saves-v|cities-v" \
  crates/caelum-core/src src src-tauri
```

Expected: no HPA-628 schema/storage increment.

- [ ] **Step 5: Manual smoke**

In a development sandbox:

1. deploy a Bus line with multiple vehicles;
2. lengthen it until Rust publishes a top-up offer;
3. add one bus;
4. verify budget/fleet/nominal row updates;
5. confirm existing moving vehicles do not jump;
6. confirm the new vehicle is not inserted directly on top of an existing vehicle in the controlled case;
7. repeat with Creative if convenient to confirm zero deduction.

- [ ] **Step 6: Final diff check**

```bash
git status --short
git diff --check
```

Commit only intentional cleanup.

## Done criteria

HPA-628 is complete when:

- one line-ID-only `AddServiceVehicle` product action exists for Bus and Metro;
- the action reuses the typed one-vehicle append core;
- Rust recomputes the live requirement and cannot overbuy;
- Standard/Creative charging reuses `CostPolicy`;
- existing vehicles/passengers are untouched by top-up;
- the new vehicle is inserted at the midpoint of the largest current travel-time gap;
- `nextVehicleCost` is Rust-derived from the same availability helper used by the mutation;
- TypeScript renders the button solely from non-null `nextVehicleCost`;
- one Bus E2E proves route-edit shortfall -> add one -> updated service state;
- no automatic resize, existing-fleet rebalancing, withdrawal, diagnostics, schema bump, migration, or compatibility work is added.
