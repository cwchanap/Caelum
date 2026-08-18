# HPA-628 Post-Deployment Fleet Top-Up Design

**Linear:** HPA-628
**Parent:** HPA-334
**Depends on:** HPA-626, now merged on `main`

## Goal

Close one concrete Phase 4 recovery gap:

> After a Bus or Metro service has deployed its initial fleet, if Rust later derives `requiredFleet > assignedFleet`, the player can buy exactly one additional vehicle from the existing Lines row.

This stays a small service-control slice. It does not introduce automatic resizing, fleet withdrawal, a vehicle manager, holding, bunching recovery, or Phase 5 diagnostics.

## Verified baseline

The implementation target is the current remote `main`, not PR #47's historical creation base.

Current `main` already contains the HPA-626 implementation:

- `crates/caelum-core/src/service_control.rs`;
- line-ID-only `SetServiceTargetHeadway` and `DeployInitialFleet`;
- shared Bus/Metro `ServiceMetrics` with `estimated_deployment_cost`;
- Metro `target_headway_seconds` and `service_metrics`;
- the mode-neutral Lines service row.

PR #47 was opened before HPA-626 merged, so its branch must be rebased onto current `main` before implementation. Do not rescope this ticket back to the older Bus-only `bus_service` shape.

## Product command

Add one product-level intent:

```rust
GameIntent::AddServiceVehicle {
    line_id: String,
}
```

Wire form:

```ts
{ type: "addServiceVehicle"; lineId: string }
```

Runtime:

```ts
addServiceVehicle(lineId: string): RuntimeCommandResult;
```

The product API carries no `mode`. `service_control` resolves Bus versus Metro from the namespaced line ID.

Low-level `AssignVehicle { mode, lineId }` remains a fixture/dev seam only.

## Reuse the existing one-vehicle mutation

`transit::assign_vehicle_costed` already owns the real one-vehicle purchase and append behavior. Do not duplicate that logic in `service_control`.

Extract its typed core as:

```rust
pub(crate) fn append_vehicle_costed(
    state: &GameSnapshot,
    vehicle: Vehicle,
) -> GameplayResult<CostedMutation>;
```

`assign_vehicle_costed` keeps string parsing at its existing boundary:

```rust
let mode = match mode {
    "bus" => TransitMode::Bus,
    "metro" => TransitMode::Metro,
    _ => return Err(...),
};
let vehicle = initial_vehicle(state, mode, line_id);
append_vehicle_costed(state, vehicle)
```

`append_vehicle_costed` uses an exhaustive `TransitMode` match when attaching the vehicle:

- `Bus` -> Bus route;
- `Metro` -> Metro line;
- `Walk` -> reject as incompatible.

Do not retain the current implicit `else => Metro` shape once the helper accepts a typed mode through `Vehicle`.

This helper owns:

- the existing `CostPolicy` quote/authorization;
- route/line lookup;
- active/operational checks;
- route/line `vehicle_ids` append;
- global `vehicles` append;
- final budget deduction.

## Authoritative top-up rule

`service_control::add_service_vehicle` recomputes from current authoritative state at dispatch. It never trusts a previously rendered metric.

The action is useful only when:

```text
line exists
AND line is active and structurally operational
AND target headway exists
AND assigned fleet > 0
AND current required fleet > assigned fleet
```

Use one small Rust helper for the shared offer predicate:

```rust
fn top_up_offer(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32>;
```

It returns `Some(vehicle_cost(mode))` only while all offer conditions are true; otherwise `None`.

Both consumers use this helper:

1. `metrics(...)` maps it to `next_vehicle_cost`;
2. `add_service_vehicle(...)` recomputes live `required_fleet` and uses the same helper as the final shortfall gate.

The mutation still performs explicit line-state validation first so product error semantics remain clear:

- missing -> `RouteNotFound`;
- deployed inactive -> `InactiveRoute`;
- deployed disconnected -> `DisconnectedLeg`;
- zero fleet or missing target -> unchanged no-op;
- already at/above live requirement -> unchanged no-op.

A stale extra click therefore returns `applied == false`; no new rejection family is required.

### Rejection ordering

Keep the existing low-level `AssignVehicle` behavior unchanged, including its current cost-authorization ordering.

For `AddServiceVehicle`, `service_control` validates the deployed service state before calling the append helper. Therefore an inactive/disconnected top-up request reports the service error before any insufficient-budget error. This difference is intentional: the product command is service-state-driven, while `AssignVehicle` remains a fixture seam.

## Deterministic insertion without fleet rebalance

Do **not** place every top-up vehicle blindly at cursor 0.

That placement is deterministic but arbitrary. If another vehicle is already at the same phase, both vehicles advance with the same per-step timing and can remain exactly bunched. The UI would then show a lower nominal headway while the new capacity is poorly distributed.

Also do **not** re-space existing vehicles. Moving passenger-carrying vehicles turns this slice into fleet rebalancing and holding semantics.

Use the smallest middle ground: place the new vehicle at the midpoint of the largest current travel-time gap.

### Algorithm

1. Derive current `RoadFlow` once.
2. Derive `round_trip_seconds` with the existing service timing walk.
3. Convert every existing vehicle on the line from its current cursor to an elapsed cycle-time offset using the same `vehicle_step_seconds` timing rule.
4. Sort offsets ascending.
5. Compute each circular gap, including the wrap-around gap from the last vehicle back to the first.
6. Pick the largest gap. On equal gaps, choose the earliest gap start for deterministic tie-breaking.
7. Insert at the midpoint of that gap.
8. Convert the midpoint back to a route cursor with existing `resolve_service_cursor`.
9. Create the new vehicle with `initial_vehicle`, overwrite only its cursor with that derived position, then pass it to `append_vehicle_costed`.

This adds only service-placement math. Existing vehicles, their passengers, their parked positions, and their cursors remain untouched.

For one existing vehicle, the largest circular gap is the full cycle, so the new vehicle is placed approximately half a cycle away.

### What this does and does not promise

This is not full fleet equalization. Adding one vehicle without moving the rest cannot guarantee perfectly uniform spacing after arbitrary route edits or prior bunching.

It does guarantee the new vehicle is inserted into the best current gap rather than at an arbitrary fixed cursor, and it avoids creating a new exact overlap when a usable gap exists.

`nominalHeadwaySeconds = roundTripSeconds / assignedFleet` remains a planning metric, not measured headway history.

## Rust-derived `nextVehicleCost`

Extend derived `ServiceMetrics`:

```rust
pub next_vehicle_cost: Option<i32>,
```

`nextVehicleCost` is non-null only when `top_up_offer(...)` says a top-up is currently available.

That means the field already encodes:

- active/operational service;
- deployed fleet;
- known requirement;
- real fleet shortfall;
- authoritative Rust vehicle price.

Dispatch still recomputes everything before mutation. The output field is advisory UI state, not authorization.

Because `ServiceMetrics` is derived output and save normalization clears it, this does not require a schema bump or migration.

## Lines-row UX

Keep all product UI in the existing Lines row.

Example shortfall:

```text
Target   6.0 min
Nominal  8.4 min
Fleet    2 / 3 required
[Add bus · $8,000]
```

Metro uses `Add train`.

TypeScript must not reimplement the shortfall predicate. The button condition is only:

```ts
route.service.nextVehicleCost !== null
```

Rust already decided whether the action is valid to offer.

One click invokes `addServiceVehicle(route.id)` exactly once. No quantity picker, confirmation, auto-repeat, health badge, or disabled-state framework.

After dispatch, the normal runtime snapshot refresh updates fleet count, nominal headway, `nextVehicleCost`, and therefore button visibility.

## Cost behavior

Reuse existing `CostPolicy` through `append_vehicle_costed`:

- Standard: deduct exactly one current vehicle cost;
- Creative: authorize the same nominal purchase and deduct zero;
- insufficient Standard budget: reject atomically with no appended vehicle.

Do not add inventory, refunds, financing, or recurring operating cost here.

## Persistence

No new authoritative field is added.

The slice adds only:

- one intent;
- one derived `ServiceMetrics` field;
- one runtime command;
- one Lines-row action;
- bounded insertion math for the new vehicle.

Existing target headway and `vehicle_ids` remain authoritative.

No schema bump, migration, compatibility alias, or storage change.

## Test strategy

### Refactor safety

The `assign_vehicle_costed` extraction affects a fixture seam used throughout `caelum-core`. After extracting `append_vehicle_costed`, run the full core suite, not only service-control tests:

```bash
cargo test -p caelum-core
```

### Rust service-control behavior

Use an already-deployed fixture with at least two existing vehicles so initial placement is genuinely spaced.

Create a live shortfall without `UpdateRoute`: modify current path step timing in a save fixture, update the stored path total, restore, and dispatch `AddServiceVehicle`.

Prove:

- Bus adds exactly one Bus;
- Metro adds exactly one Metro vehicle;
- correct mode/capacity;
- new vehicle cursor differs from every existing vehicle cursor in the controlled spaced fixture;
- largest-gap midpoint helper chooses the expected deterministic gap on a synthetic cycle;
- all pre-existing vehicle cursors, parked positions, and passenger IDs are unchanged by top-up;
- Standard deducts one vehicle cost;
- Creative deducts zero;
- insufficient budget leaves fleet and budget unchanged;
- zero fleet is unchanged;
- at-target/stale repeated action is unchanged and cannot overbuy;
- inactive/disconnected/missing lines retain their current service rejection behavior.

Do not use `UpdateRoute` in the preservation proof. Route editing intentionally rebases vehicles and riders.

### Derived metrics/wire

Prove:

- `nextVehicleCost` appears for an active operational deployed shortfall;
- it is null before deployment, at target, when paused, and when broken;
- Bus and Metro prices come from Rust;
- output wire uses `nextVehicleCost`;
- persisted saves still omit `serviceMetrics`.

### Runtime/UI

Prove:

- runtime dispatches `{ type: "addServiceVehicle", lineId }` with no mode;
- selector forwards `nextVehicleCost` without calculation;
- deployed row shows assigned/required fleet;
- Bus and Metro labels are correct;
- button exists iff Rust supplies non-null `nextVehicleCost`;
- one click calls the callback once.

### Representative E2E

Use one Bus browser flow:

1. create and deploy a Bus line;
2. edit it to make the live service requirement rise;
3. read post-edit Rust `serviceMetrics` and require a real `requiredFleet > assignedFleet` shortfall;
4. capture post-edit `assignedFleet`, `requiredFleet`, `nextVehicleCost`, nominal headway, and budget;
5. click Add bus once;
6. assert assigned fleet becomes `postEditAssigned + 1`;
7. assert Standard budget falls by the Rust-provided `nextVehicleCost`;
8. assert nominal headway updates downward;
9. derive button visibility from the post-add `nextVehicleCost` rather than assuming the shortfall was exactly one.

Do not assert cursor/passenger identity across `UpdateRoute`; that lifecycle intentionally rebases them.

No second Metro E2E is needed.

## Risks and containment

### Planning branch predates the HPA-626 merge

PR #47 was created from the older main tip. Rebase onto current `main` before implementation and verify the shared service symbols before coding.

### `AssignVehicle` extraction has a broad test blast radius

Many core fixtures use `AssignVehicle`. Keep Task 1 behavior-preserving and gate it with `cargo test -p caelum-core` before adding top-up behavior.

### Placement can grow into fleet management

Do only one greedy largest-gap insertion. Do not move existing vehicles, retain spacing history, add holding, or build a reusable optimizer.

## Explicit non-goals

- automatic or bulk fleet resize;
- moving/re-spacing existing vehicles;
- vehicle withdrawal, reassignment, sale, or refund;
- post-deployment target editing;
- measured headway history;
- bunching detection, holding, or recovery;
- fleet manager/depot/crew/maintenance UI;
- crowding or route-health diagnostics;
- operating-cost accounting;
- save migration or backward compatibility.

## Phase sequencing

HPA-626 is already merged on remote `main`. HPA-628 remains the next bounded Phase 4 recovery slice.

After HPA-628 is playable, evaluate HPA-334 for closeout. Do not pre-build Phase 5 diagnostics until a concrete playtest problem justifies them.
