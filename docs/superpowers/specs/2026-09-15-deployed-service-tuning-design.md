# HPA-48 Deployed Service Tuning Design

**Linear:** HPA-48  
**Repository:** `cwchanap/Caelum`  
**Baseline:** `main` at `bf515aad207de807302fae0b5b8d5c9e1fb26434`

## Goal

Make an already-running Bus or Metro line operable without forcing the player back into route geometry editing.

The player can:

1. select a line to inspect/highlight it;
2. change its target headway after deployment;
3. see Rust recompute the required fleet;
4. buy one additional vehicle at a time through the existing top-up action when the tighter target creates a shortfall.

This is a gameplay-polish cut over existing service-control seams, not a new fleet-management system.

## Verified baseline

Current `main` already has almost every required primitive:

- `UiState.selectedRouteId` and `RuntimeController.selectRoute(...)` select/highlight a line without changing simulation state;
- WebGPU route/vehicle emphasis and DOM map text already consume `selectedRouteId`;
- `GameIntent::SetServiceTargetHeadway` and the matching runtime command already update a line target;
- `service_control` owns round-trip timing, `requiredFleet`, nominal headway, daily cost, waiting-health metrics, and the 60-second minimum target;
- HPA-628 already added `AddServiceVehicle`, Rust-derived `nextVehicleCost`, cost policy reuse, and deterministic largest-gap insertion;
- the Lines panel already renders Target, Nominal, Fleet, Daily cost, wait warnings, and the one-vehicle top-up button.

Two UI/lifecycle choices currently prevent the intended operating loop:

1. the Lines row's primary action calls `onEditRoute`, so merely opening a line enters the route draft/editor;
2. `service_control::set_service_target_headway` rejects any line with assigned vehicles using `FleetAlreadyAssigned`, and the headway input is only rendered before deployment.

Those are the only product restrictions this slice needs to remove.

## Product flow

### 1. Select is inspection; Edit is explicit

Restore the existing UI-only selection path to the Lines panel:

```text
click line summary -> runtime.selectRoute(lineId) -> selectedRouteId
```

The selected line remains highlighted by the existing WebGPU/render selectors. No backend intent is dispatched and no route draft is created.

Add a separate `Edit route` button/action on the row. That action keeps calling the existing route-editor entry point.

This separates two different player intents that are currently conflated:

- **operate/inspect service** — cheap, non-structural, safe while vehicles are running;
- **edit geometry** — structural route editing with its existing route-draft lifecycle.

Do not introduce a new service-details screen, modal, or route-selection state. `selectedRouteId` is already the correct state.

## 2. Target headway remains the desired service level after deployment

`targetHeadwaySeconds` already means the player's desired interval and Rust already derives:

```text
requiredFleet = ceil(roundTripSeconds / targetHeadwaySeconds)
```

Allow `SetServiceTargetHeadway` after deployment by removing the assigned-fleet rejection from `set_service_target_headway`.

Keep the rest of the contract unchanged:

- line ID resolves Bus vs Metro in Rust;
- target must be at least 60 seconds;
- the mutation changes only `target_headway_seconds`;
- no vehicle is added, removed, moved, re-spaced, parked, or reassigned;
- no passenger/trip state is touched;
- service metrics are re-derived from the accepted snapshot as they are today.

`FleetAlreadyAssigned` remains valid for a second `DeployInitialFleet` attempt, so do not remove that rejection code.

### Tightening the target

If the new target causes:

```text
requiredFleet > assignedFleet
```

existing `top_up_offer(...)` produces `nextVehicleCost`, and the existing Add bus/train control becomes available.

The player can click repeatedly, one vehicle per dispatch, until Rust no longer reports a shortfall.

### Loosening the target

If the new target causes:

```text
requiredFleet < assignedFleet
```

keep every assigned vehicle running. `nextVehicleCost` stays null and no automatic subtraction occurs.

This is deliberate. Vehicle retirement/sale/reassignment needs its own product semantics and should not be smuggled into target editing.

## 3. Keep capacity changes target-driven

Do **not** broaden HPA-628's Add action into an unconditional `Buy vehicle` button.

The existing Rust offer already provides a useful invariant:

```text
Add is offered only while the authoritative service target requires more fleet.
```

That gives the player direct control without permitting accidental overbuying and without adding a second desired-fleet concept beside target headway.

The tuning loop is therefore:

```text
observe service -> adjust target -> inspect required fleet -> add capacity if needed
```

not:

```text
arbitrarily resize fleet -> invent another rule for target/nominal reconciliation
```

## Lines-panel UX

Keep one list and one row model.

For each line:

- primary line summary selects/highlights the line;
- explicit `Edit route` enters geometry editing;
- rename/color/pause/delete/repair controls keep their current behavior;
- target-headway input is available both before and after deployment;
- pre-deployment rows keep Required, estimated deployment cost, estimated daily cost, and Deploy fleet;
- deployed rows keep Nominal, assigned/required Fleet, Daily cost, wait warning, and the existing Add bus/train action.

The deployed target input should reuse the same validation and callback as pre-deployment target editing. Do not create a second form model or duplicate target rules in TypeScript.

## State and persistence

No new authoritative state is needed.

Existing fields remain sufficient:

- `targetHeadwaySeconds` — desired interval;
- `vehicleIds` — assigned fleet;
- `serviceMetrics` — derived output only;
- `selectedRouteId` — UI-only inspection selection.

Therefore:

- no schema bump;
- no migration;
- no new save field;
- no new wire intent;
- no compatibility alias;
- no new renderer/presentation schema.

## Rejection and stale-action behavior

Keep current authoritative dispatch validation.

`SetServiceTargetHeadway`:

- missing line -> existing `RouteNotFound`;
- target below 60 seconds -> existing `InvalidHeadway`;
- assigned fleet is no longer a rejection.

`AddServiceVehicle` remains unchanged:

- recomputes live service state and requirement at dispatch;
- rejects inactive/disconnected service as it does today;
- returns a free no-op if the offer is stale or the requirement is already met;
- applies the current CostPolicy and one-vehicle placement when the offer is valid.

No new rejection family is justified.

## Test strategy

### Rust service-control tests

Replace the old post-deployment target-lock assertion with behavior tests proving:

- deployed Bus target can change;
- deployed Metro target can change;
- target below 60 seconds still rejects;
- retargeting preserves the entire vehicle collection for the line, including IDs, cursors, parked positions, passenger IDs, and budget;
- tightening target recomputes a larger `required_fleet` and exposes `next_vehicle_cost` when there is a shortfall;
- loosening target can leave surplus fleet and does not remove vehicles;
- second initial deployment still rejects with `FleetAlreadyAssigned`.

Do not re-test HPA-628's largest-gap algorithm in this ticket beyond the integration coverage needed for the retarget -> top-up flow.

### Runtime/UI tests

Prove:

- clicking the primary line summary invokes `onSelectRoute(lineId)`, not `onEditRoute`;
- selected styling still comes from `route.selected`;
- explicit `Edit route` invokes `onEditRoute(lineId)` once;
- deployed Bus and Metro rows expose the same target editor used before deployment;
- valid deployed target edits invoke `onSetServiceTargetHeadway` with seconds;
- existing fleet/nominal/daily-cost/wait-warning/add-vehicle presentation remains intact.

`RuntimeController.selectRoute` is already tested; only add runtime coverage if the UI wiring reveals a missing contract.

### Representative browser flow

Use one Bus E2E, not duplicate Bus + Metro browser flows:

1. create a Bus line with a valid initial target;
2. deploy its initial fleet;
3. return to the normal Lines list;
4. click the line summary and assert it is selected without opening a route draft;
5. set a tighter valid target that deterministically makes `requiredFleet > assignedFleet`;
6. read the post-dispatch runtime snapshot and assert target/required-fleet changed while the original fleet remains present;
7. click Add bus once;
8. assert assigned fleet increases by exactly one and Standard budget falls by Rust's pre-click `nextVehicleCost`;
9. assert the route never entered geometry edit during the operating flow.

Metro parity stays at Rust/component level.

## Alternatives rejected

### Automatically resize fleet when target changes

Rejected. It couples a cheap planning edit to potentially large purchases/removals and creates refund/retirement/re-spacing semantics. Existing explicit top-up is clearer and safer.

### Allow arbitrary vehicle purchases

Rejected for this slice. Target-driven top-up already gives a concrete operating loop and prevents accidental overbuying. Arbitrary fleet sizing can be considered later if playtesting shows a real need.

### Add a dedicated service-management screen

Rejected. The Lines panel already has all relevant service readouts/actions and `selectedRouteId` already gives map-linked inspection.

### Build timetables, peak bands, depots, or automatic balancing

Rejected. None are required to make the existing target/fleet model operable.

## Explicit non-goals

- automatic fleet resizing;
- vehicle removal, retirement, sale, refund, or reassignment;
- timetables or peak/off-peak targets;
- depots, maintenance, crew, or inventory;
- bunching detection, holding, or re-spacing;
- new service-plan/domain abstraction;
- route geometry changes beyond the existing explicit editor;
- new wait-health metrics;
- camera/zoom or renderer work;
- save/wire/schema migration;
- new image assets.

## Delivery

HPA-48 stays one ticket and one PR. The planning docs, implementation, tests, and representative E2E remain on this branch/PR.
