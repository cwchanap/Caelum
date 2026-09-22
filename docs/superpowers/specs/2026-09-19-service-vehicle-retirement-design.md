# HPA-368 — One-vehicle service retirement design

## Context

HPA-48 made deployed Bus and Metro service tunable from the Lines panel:

- select a line without entering route geometry editing;
- change the target headway;
- buy one additional vehicle at a time;
- read the current assigned/recommended fleet, estimated interval, daily operating cost, and live waiting evidence.

That slice intentionally left one asymmetry: capacity can be added but never removed. The design explicitly named a later one-vehicle removal/retirement control if irreversible over-purchase became a usability problem.

HPA-464 has now completed the warning → stop/platform → service-control navigation loop. The Lines panel therefore has enough information to make a downward fleet decision meaningful: the player can see current fleet, recommendation, estimated interval, current wait, and daily cost, but cannot trade excess capacity back for lower operating cost.

This slice closes only that gap.

## Goal

Let the player retire exactly one safely removable Bus or Metro vehicle from the existing Lines controls, immediately reducing the line's deployed fleet and derived operating cost without touching route geometry or any rider.

The implementation must stay smaller than a fleet-management system.

## Existing seams to reuse

The current code already provides the needed ownership boundaries:

- `GameIntent::AddServiceVehicle { line_id }` is line-ID only.
- `service_control::service_mode` derives Bus vs Metro from the line ID.
- `Route.vehicle_ids` / `MetroLine.vehicle_ids` are the line-owned ordered vehicle IDs.
- initial fleet deployment extends that list, and one-at-a-time top-up appends to it.
- authoritative `Vehicle.passenger_ids` remains in Rust and is intentionally absent from frontend presentation.
- `ServiceMetrics` already publishes assigned/recommended fleet, estimated interval, daily cost, add-vehicle availability/price, and wait health.
- `service_metrics` is derived output; save normalization does not persist it as authoritative state.
- the Lines panel already owns the service controls and needs no second screen.
- `RuntimeController.addServiceVehicle` and its backend intent path show the intended thin TypeScript command shape.

Do not reuse route-break passenger invalidation for retirement. Route lifecycle deliberately parks vehicles and invalidates/replans riders when topology breaks; retirement must never disturb riders at all.

## Product rule

Add one line-ID-only intent:

```rust
GameIntent::RetireServiceVehicle {
    line_id: String,
}
```

and the equivalent TypeScript command:

```ts
{ type: "retireServiceVehicle"; lineId: string }
```

Rust remains authoritative for mode, eligibility, and concrete vehicle selection.

## Eligibility

The retirement control is offered from **slow service state only** when all of these are true:

1. the line is active;
2. the line is operational under the existing connected-leg rule; and
3. at least two vehicles are assigned.

Do not scan live passenger occupancy to decide whether the button exists. Boarding/alighting changes `passenger_ids` during ticks, so an occupancy-backed offer would flicker with live service and could disappear between pointer-down and dispatch.

Global simulation pause is explicitly **not** an eligibility gate. Here "active" means the line's own `route.active` / `line.active` flag. A player may globally pause the simulation, add capacity, and retire an empty vehicle while time is frozen; this is the safe HPA-48 over-purchase undo path.

The last vehicle is never removable in this slice. A zero-fleet transition already has separate initial-deployment semantics, and service shutdown is not the problem being solved.

The target headway is not an eligibility floor. A player may retire below `requiredFleet`, down to one vehicle. Recommendation remains guidance, symmetric with HPA-48 allowing purchases above recommendation.

Dispatch uses this order:

1. unknown line: existing `RouteNotFound`;
2. one remaining vehicle: unchanged-state no-op because there is no downsize to perform;
3. inactive line: existing `InactiveRoute`;
4. disconnected line: existing `DisconnectedLeg`;
5. reverse scan for an empty vehicle;
6. if every removable vehicle is occupied: reject with new `VehiclesOccupied`;
7. otherwise remove exactly one empty vehicle.

This keeps service-state rejection authoritative and treats occupancy as the live safety check it actually is. A stale click never ejects a rider, but it also does not fail silently: the player receives a normal gameplay rejection.

Add the TypeScript rejection union/message exhaustively. Use mode-neutral player copy such as **"Every removable vehicle on this line has riders."** so the frontend does not derive Bus vs Metro merely to format the error.

## Deterministic vehicle choice

Use the line's existing `vehicle_ids` order as the only ordering source.

Walk `vehicle_ids` in reverse and choose the first ID whose authoritative `Vehicle`:

- belongs to the same line;
- has the derived line mode; and
- has `passenger_ids.is_empty()`.

This naturally prefers the most recently assigned empty vehicle, which is usually the most recent top-up after an accidental over-purchase.

Do not add:

- purchase timestamps;
- retirement priority;
- per-vehicle UI selection;
- occupancy counts on the frontend;
- a separate fleet ordering field.

The durable entity membership validation already protects normal snapshots from mismatched line/vehicle ownership. The retirement predicate should still match line and mode rather than trusting only an ID lookup.

For the headline over-purchase undo, reverse order has an additional useful property: `AddServiceVehicle` placed the newest vehicle at the midpoint of the largest cycle gap. Immediately retiring that same newest empty vehicle restores the exact pre-purchase fleet spacing without any re-spacing mutation.

Accepted tradeoff: if fleet occupancy/churn causes retirement to remove an older middle vehicle instead, the remaining fleet can keep a larger physical gap while `nominalHeadwaySeconds` still reports `roundTrip / fleet`. This slice accepts that optimistic nominal interval rather than adding fleet re-spacing; a later measured need can address it in the existing service-control timing seam.

## Mutation

Once Rust resolves an eligible vehicle ID:

1. clone the snapshot;
2. remove exactly that ID from the selected route/metro line's `vehicle_ids`;
3. remove exactly that `Vehicle` from `transit.vehicles`;
4. leave every other field unchanged;
5. return a free `CostedMutation`.

There is no spacing/rebalance step. Remaining vehicles keep their exact:

- IDs;
- itinerary indexes;
- path-step indexes;
- step progress;
- parked positions;
- passenger IDs.

Active trips are not rewritten. Route target, geometry, revision, active flag, and platform assignments are not changed.

Because only an empty vehicle is removed, there is no passenger handoff problem to solve.

## Economy semantics

Retirement is disposal, not resale.

The budget is unchanged in both Standard and Creative.

Do not call `CostPolicy`, calculate depreciation, or add a refund field. The existing `operating_cost` rules already derive current daily liability from deployed fleet count, so the financial consequence appears automatically after the mutation:

- active/operational line: daily cost drops by one existing per-mode vehicle cost;
- route-inactive/broken line: the retirement action is not offered by this slice.

Global simulation pause does not suppress retirement availability or dispatch; only the line's own inactive/broken service state does.

The purchase price already paid is sunk.

The UI must make this visible in the action copy:

- `Retire bus · no refund`
- `Retire train · no refund`

No confirmation dialog is added. The action is explicit, line-scoped, removes only one vehicle, and the no-refund consequence is visible on the button.

## Derived presentation contract

Add one Rust-owned field to `ServiceMetrics`:

```rust
pub can_retire_vehicle: bool
```

Wire spelling:

```ts
canRetireVehicle: boolean
```

This is the only new presentation value.

Use two deliberately separate helpers:

- `retire_vehicle_offer(active, legs, assigned_fleet)` — a small sibling of `add_vehicle_offer`, based only on active/operational service and fleet ≥ 2;
- one empty-candidate helper — reverse-scans authoritative line vehicles and is consumed only by `retire_service_vehicle`.

Do not duplicate either rule in TypeScript.

`metrics(...)` receives the stable offer bit/count inputs and does **not** scan `Vehicle.passenger_ids`. This keeps the hot presentation path independent of live occupancy and prevents the button from blinking at tick cadence.

When retirement succeeds, the existing derived values naturally refresh:

- `assignedFleet` decreases by one;
- `requiredFleet` is unchanged;
- `nominalHeadwaySeconds` increases for the smaller fleet;
- `dailyOperatingCost` decreases;
- `nextVehicleCost` remains governed by the existing add rule;
- wait metrics remain whatever current riders actually show;
- `canRetireVehicle` is recomputed from the new fleet.

No "service improved" or "service worsened" conclusion is generated.

## UI and runtime

Extend the existing thin path only:

- backend intent union gains `retireServiceVehicle`;
- `RuntimeController` gains `retireServiceVehicle(lineId)`;
- `createGameRuntime` forwards the command through `enqueueDispatch`;
- `App.svelte` adds one-line handler delegation;
- `LinesPanel.svelte` receives one callback and renders the action iff `canRetireVehicle` is true.

Place the action beside the existing add-service-vehicle control rather than creating another section.

The Lines panel does not inspect `vehicleIds` to decide safety. It only renders the Rust-owned availability bit.

## Persistence and compatibility

No snapshot schema bump is required.

This adds:

- one new command variant;
- one derived `ServiceMetrics` field.

The reason is structural: route/metro `service_metrics` is already runtime-derived and marked `skip_deserializing` with a default, so incoming saves never make any `ServiceMetrics` field authoritative. Adding `canRetireVehicle` therefore changes presentation output, not the durable load contract.

It adds no durable field. Existing development compatibility policy remains unchanged; no migration, alias, fallback parser, or compatibility wrapper is added.

## Focused verification

### Rust domain tests

Cover both Bus and Metro through shared/table-driven fixtures where practical.

Required proofs:

1. reverse-order choice removes the newest assigned empty vehicle;
2. occupied vehicles are skipped;
3. if every removable candidate is occupied, dispatch rejects with `VehiclesOccupied`;
4. a one-vehicle fleet is an unchanged-state no-op;
5. inactive and disconnected lines keep the existing service-control rejections when a downsize is otherwise possible;
6. global simulation pause keeps `canRetireVehicle == true`, retirement dispatch applies when an empty candidate exists, and budget remains unchanged;
7. retirement below `requiredFleet` is allowed;
8. one authoritative-snapshot equality test proves the mutation changes only the selected line's `vehicle_ids` plus `transit.vehicles` removal; build expected state from the before snapshot and compare the whole snapshot rather than mirroring every surviving field;
9. a separate output-metrics test proves fleet, interval, daily cost, add offer, wait health, and retirement availability refresh.

### Wire/runtime/UI tests

Pin:

- Rust JSON spelling for `RetireServiceVehicle` and the exhaustive `GameIntent` type-tag table;
- `ServiceMetrics.canRetireVehicle`;
- backend/runtime forwarding of `{ type: "retireServiceVehicle", lineId }`;
- selector forwarding with no TypeScript eligibility formula;
- Lines retirement stays visible when `canRetireVehicle === true` even if `assignedFleet < requiredFleet`;
- `VehiclesOccupied` has exhaustive TypeScript rejection copy;
- Bus/Metro no-refund copy/callback;
- App handler wiring.

### Browser/WASM proof

Reuse the existing route/service E2E setup.

A representative Bus flow should:

1. use an active deployed line;
2. globally pause simulation so a freshly purchased vehicle cannot board before retirement;
3. record fleet, daily cost, and budget;
4. use the existing Add bus action;
5. observe fleet +1 and purchase budget deduction;
6. immediately use `Retire bus · no refund`;
7. observe fleet -1 and daily cost return to the prior value;
8. assert budget remains at the post-purchase value rather than receiving a refund.

Rust coverage supplies Bus/Metro parity; do not clone the browser journey for Metro.

## Non-goals

- sale/refund/depreciation;
- deferred "retire when empty" state;
- occupied-rider ejection or requeue;
- selecting a specific vehicle;
- retiring the last vehicle;
- re-spacing remaining vehicles;
- changing target headway automatically;
- fleet presets or desired-fleet durable state;
- automatic optimization;
- depots, garages, maintenance, staff, timetables, or service bands;
- historical cost/reliability dashboards;
- undo/history;
- persistence migration;
- new renderer work;
- new image or audio assets.

## Delivery

HPA-368 remains one ticket and one PR.

This planning commit contains only this design and the implementation plan. Production code, focused tests, browser proof, and final verification continue on the same draft PR.
