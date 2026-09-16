# HPA-48 Deployed Service Tuning Design

**Linear:** HPA-48  
**Repository:** `cwchanap/Caelum`  
**Baseline:** `main` at `bf515aad207de807302fae0b5b8d5c9e1fb26434`

## Goal

Make an already-running Bus or Metro line operable without forcing the player back into route geometry editing.

The player can:

1. select a line to inspect/highlight it;
2. change its target headway after deployment;
3. read the resulting recommended fleet and estimated interval;
4. buy one additional vehicle at a time on an active, operational deployed service even when the fleet already meets or exceeds the recommendation;
5. watch actual wait, fleet, and operating-cost feedback refresh without the UI claiming that a target edit or purchase automatically solved the service problem.

This is a gameplay-polish cut over existing service-control seams, not a new fleet-management system.

## Verified baseline

Current `main` already has almost every required primitive:

- `UiState.selectedRouteId` and `RuntimeController.selectRoute(...)` select/highlight a line without changing simulation state;
- `selectRoute(...)` already toggles the same selected line off on a second click; keep that interaction rather than making selection sticky;
- `startRouteEdit(...)` already refuses to replace an open route draft, and the Lines list is already hidden while drafting;
- WebGPU route/vehicle emphasis and DOM map text already consume `selectedRouteId`;
- `GameIntent::SetServiceTargetHeadway` and the matching runtime command already update a line target;
- `service_control` owns round-trip timing, `requiredFleet`, nominal headway, daily cost, waiting-health metrics, and the 60-second minimum target;
- HPA-628 already added `AddServiceVehicle`, Rust-derived `nextVehicleCost`, cost policy reuse, and deterministic largest-gap insertion for the newly added vehicle;
- the Lines panel already renders Target, Nominal, Fleet, Daily cost, wait warnings, and the one-vehicle Add action;
- `longestWaitSeconds` and `waitingAtRiskCount` already exist separately in Rust metrics and the TypeScript route view model.

The slice needs to remove or clarify four product restrictions:

1. the Lines row's primary action calls `onEditRoute`, so merely opening a line enters the route draft/editor;
2. `service_control::set_service_target_headway` rejects any line with assigned vehicles using `FleetAlreadyAssigned`, and the headway input is only rendered before deployment;
3. HPA-628 currently treats `requiredFleet` as a purchase ceiling, so `nextVehicleCost` disappears and `AddServiceVehicle` becomes a no-op once the recommendation is met;
4. the wait warning currently couples `nextVehicleCost` to prescriptive copy (`Add ... to recover`), even though a long wait alone does not prove that another vehicle is the cause or cure.

No new durable state, transport model, or service-management screen is needed.

## Product flow

### 1. Select is inspection; Edit is explicit

Restore the existing UI-only selection path to the Lines panel:

```text
click line summary -> runtime.selectRoute(lineId) -> selectedRouteId
```

The selected line remains highlighted by the existing WebGPU/render selectors. No backend intent is dispatched and no route draft is created.

Preserve the existing `selectRoute(...)` toggle: clicking the already-selected row clears `selectedRouteId`. HPA-48 only restores this seam to the Lines panel; it does not redefine selection semantics or add another runtime API/state.

Add a separate `Edit route` button/action on the row. That action keeps calling the existing route-editor entry point and preserves the current draft Save/Cancel gating rather than silently replacing an open draft.

This separates two player intents:

- **operate/inspect service** — cheap, non-structural, safe while vehicles are running;
- **edit geometry** — structural route editing with its existing route-draft lifecycle.

Do not introduce a new service-details screen, modal, or route-selection state. `selectedRouteId` is already the correct state.

## 2. Target headway remains a planning input after deployment

`targetHeadwaySeconds` remains the player's desired interval and Rust already derives:

```text
requiredFleet = ceil(roundTripSeconds / targetHeadwaySeconds)
```

Allow `SetServiceTargetHeadway` after deployment by removing the assigned-fleet rejection from `set_service_target_headway`.

Keep the rest of the mutation deliberately narrow:

- line ID resolves Bus vs Metro in Rust;
- target must be at least 60 seconds;
- the mutation changes only `target_headway_seconds`;
- no vehicle is added, removed, moved, re-spaced, parked, or reassigned;
- no passenger/trip state is touched;
- service metrics are re-derived from the accepted snapshot as they are today.

`FleetAlreadyAssigned` remains valid for a second `DeployInitialFleet` attempt, so do not remove that rejection code.

Changing the target changes the recommendation, not the fleet. Tightening may raise `requiredFleet`; loosening may leave a surplus fleet running. No automatic purchase, retirement, refund, or operating-cost saving is implied.

## 3. Recommended fleet is guidance, not a purchase ceiling

The player may explicitly buy one additional vehicle whenever all of these are true:

- the line has an already-deployed fleet (`assignedFleet > 0`);
- a valid target exists;
- the route itself is active;
- the route is operational/connected;
- the existing purchase policy permits the spend.

`assignedFleet < requiredFleet` is **not** an eligibility rule anymore. `requiredFleet` remains useful planning guidance for the target interval, but the player may intentionally run extra capacity.

Keep the existing public seams:

- `AddServiceVehicle` remains the gameplay intent;
- `nextVehicleCost` remains the Rust-owned price/eligibility output;
- current Bus/Metro vehicle prices and `CostPolicy` remain authoritative;
- one accepted dispatch adds exactly one correctly typed vehicle.

The private helper should reflect the new semantics. Rename `top_up_offer(...)` to a name such as `add_vehicle_offer(...)` rather than retaining a shortfall-oriented name after shortfall stops being part of the rule. Both service metrics and `add_service_vehicle(...)` continue to use that one helper so UI offer state and dispatch eligibility cannot drift.

### Preserve the existing insertion behavior

HPA-628 already inserts the newly purchased vehicle at the midpoint of the largest current cycle gap. Keep that behavior.

The rule is:

- preserve every existing vehicle's cursor/passengers/placement;
- place only the new vehicle using the existing deterministic largest-gap insertion;
- do not re-space, rebalance, or otherwise move the existing fleet;
- do not introduce a fleet optimizer.

This retains the useful HPA-628 behavior without implying perfect headway equalization.

### Zero fleet and route failures

A zero-fleet route still uses the existing initial-deployment flow. `AddServiceVehicle` does not become an alternate first-deployment path.

A route that is itself paused/inactive or broken/disconnected still cannot buy a vehicle through this action.

### Global simulation pause

A globally paused simulation should still expose and accept line-operating actions for an otherwise active, operational service. Pause is a natural time for the player to inspect and tune the network.

Therefore global pause must not suppress `nextVehicleCost` or force `AddServiceVehicle` to no-op. This is a Rust service-control contract: remove the global-pause gate from the shared offer/dispatch eligibility, while route-active and route-operational checks remain authoritative. `LinesPanel` does not need pause-specific state or logic; it continues to render the Add action solely from `nextVehicleCost`.

## 4. Operating information must stay descriptive

Keep one Lines-panel row model and use the existing Rust-owned metrics.

For each deployed line show:

- editable **Target**;
- **Estimated interval** using the existing `nominalHeadwaySeconds` value;
- current assigned fleet plus **Recommended** fleet using the existing `requiredFleet` value;
- current **Daily cost**;
- nominal next-vehicle purchase price through the existing Add button when eligible;
- **Longest wait** whenever `longestWaitSeconds !== null`;
- the existing target/patience-relative warning when `waitingAtRiskCount > 0`.

Keep internal field names such as `requiredFleet` and `nominalHeadwaySeconds`. They are stable domain/projection names and do not need a wire/schema rename merely because the player-facing copy becomes `Recommended` and `Estimated interval`.

A compact deployed presentation can read conceptually as:

```text
Target                 4 min   [edit]
Estimated interval     3.6 min
Fleet                  4
Recommended            3
Daily cost             $1,600
Longest wait           5.2 min
2 riders at risk
[Add bus · $2,000]
```

Do not render `4 / 3 required`; extra fleet is now a valid player choice.

### Raw wait and warning are different signals

`longestWaitSeconds` is current observed wait evidence. `waitingAtRiskCount` is a warning derived relative to the current target and patience threshold.

Keep them separate in the UI:

- show `Longest wait` whenever there is at least one relevant waiting passenger;
- `null` means no current waiter and should render as unavailable/absent, not as a measured zero;
- a real zero-second wait remains a valid value;
- show the warning only when `waitingAtRiskCount > 0`;
- removing the warning because the target changed must not hide/reset the raw longest wait;
- a successful purchase refreshes ordinary simulation/service values but does not display `problem solved` or equivalent causal language.

Remove the current warning suffix `Add bus/train to recover`. The Add button remains nearby as an independent player action. A long wait alone is not a diagnosis that capacity is the cause.

No new reliability score, historical series, capacity diagnosis, or extra wait metric is justified.

## Lines-panel UX

Keep one list and one row model.

For each line:

- primary line summary selects/highlights the line using the existing toggle behavior;
- explicit `Edit route` enters geometry editing through the existing draft gate;
- rename/color/pause/delete/repair controls keep their current behavior;
- target-headway input is available both before and after deployment;
- pre-deployment rows keep Recommended fleet, estimated deployment cost, estimated daily cost, and Deploy fleet;
- deployed rows use Estimated interval, Fleet, Recommended, Daily cost, raw Longest wait, factual risk warning, and the Add bus/train action.

The deployed target input should reuse the same validation and callback as pre-deployment target editing. Do not create a second form model or duplicate target rules in TypeScript.

Svelte formats and displays values. Rust owns target validation, recommendation math, purchase eligibility, price, cost policy, and wait metrics.

## State and persistence

No new authoritative state is needed.

Existing fields remain sufficient:

- `targetHeadwaySeconds` — desired/planning interval;
- `vehicleIds` — assigned fleet;
- `serviceMetrics.requiredFleet` — current recommendation;
- `serviceMetrics.nominalHeadwaySeconds` — current estimated interval from round-trip/fleet math;
- `serviceMetrics.nextVehicleCost` — one-vehicle purchase offer/price;
- `serviceMetrics.longestWaitSeconds` — raw current longest wait;
- `serviceMetrics.waitingAtRiskCount` — target/patience-relative warning count;
- `selectedRouteId` — UI-only inspection selection.

Therefore:

- no schema bump;
- no migration;
- no new save field;
- no new gameplay intent;
- no compatibility alias;
- no new backend query;
- no new renderer/presentation schema solely for this slice.

## Rejection and stale-action behavior

Keep authoritative dispatch validation.

`SetServiceTargetHeadway`:

- missing line -> existing `RouteNotFound`;
- target below 60 seconds -> existing `InvalidHeadway`;
- assigned fleet is no longer a rejection.

`AddServiceVehicle`:

- zero fleet or missing target -> unchanged/free no-op, preserving the initial-deployment path;
- inactive route -> existing `InactiveRoute` rejection;
- disconnected route -> existing `DisconnectedLeg` rejection;
- global simulation pause alone -> still eligible if the route itself is active and operational;
- assigned fleet at/above recommendation -> still eligible;
- Standard mode insufficient budget -> existing atomic `InsufficientBudget` rejection with unchanged fleet/budget;
- Creative mode -> existing non-deducting purchase behavior;
- accepted dispatch -> append exactly one vehicle with existing largest-gap placement.

Do not add a new rejection family for this slice.

## Test strategy

### Rust service-control tests

Several current tests encode the old product and must be **replaced/inverted**, not kept beside new tests:

- `target_headway_is_setup_only_and_enforces_the_minimum` currently expects assigned fleet -> `FleetAlreadyAssigned`; retain its minimum/no-op coverage but replace the post-assignment lock with deployed-retarget behavior;
- `repeated_top_up_actions_stop_at_the_live_requirement` currently asserts the recommendation is a hard purchase ceiling; replace it with successive accepted one-vehicle purchases at/above recommendation;
- `add_service_vehicle_is_a_free_no_op_while_paused` and the paused-offer assertion inside `add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet` currently encode global pause suppression; invert them so pause keeps an otherwise valid offer/action;
- `active_shortfall_metric_publishes_one_vehicle_price_but_pause_hides_it` currently expects pause to clear `next_vehicle_cost`; retain broken-route coverage but invert the paused case;
- `top_up_offer_requires_an_operational_deployed_shortfall` becomes the renamed `add_vehicle_offer` unit contract and must assert at/above-recommendation eligibility instead of shortfall-only eligibility.

The resulting behavior coverage proves:

- deployed Bus target can change;
- deployed Metro target can change;
- target below 60 seconds still rejects;
- retargeting preserves existing vehicle IDs, itinerary/path cursors, parked positions, passenger IDs, route/trip state, and budget;
- target changes recompute `required_fleet` without adding/removing vehicles;
- a looser target can leave `assigned_fleet > required_fleet`;
- an active operational Bus can buy exactly one vehicle while already at/above recommendation;
- Metro has the same at/above-recommendation purchase rule;
- successive valid purchases remain available and each accepted dispatch adds exactly one vehicle;
- existing vehicles remain bit-for-bit stable across the purchase while the new vehicle uses the existing largest-gap placement path;
- insufficient Standard budget is atomic;
- Creative purchase keeps budget unchanged;
- global simulation pause does not hide/reject an otherwise valid Add action;
- route inactive/disconnected still blocks Add;
- second initial deployment still rejects with `FleetAlreadyAssigned`.

Keep largest-gap algorithm unit tests where they already live; HPA-48 only needs integration coverage proving the revised eligibility still goes through that insertion path.

For raw wait vs warning, extend the existing wait-test seams rather than creating another waiter pipeline:

- keep `waiting_health_counts_past_target_or_low_patience_platform_waiters` and `waiting_health_does_not_inherit_previous_line_wait_across_transfer` as the formula/unit authority;
- add one dispatch characterization in `crates/caelum-core/tests/service_control.rs` using the existing `waiting_transit_trip(...)` helper;
- use a waiter at 90 seconds with patience still above the independent 60-second floor: target 60 -> risk > 0, retarget 120 -> same trip and `longest_wait_seconds = Some(90.0)`, risk 0.

This proves a target change changes the warning threshold, not observed wait history/state, without duplicating waiter construction logic.

### Runtime/UI tests

Prove:

- clicking the primary line summary invokes `onSelectRoute(lineId)`, not `onEditRoute`;
- the existing runtime toggle remains authoritative: selecting the same line again clears selection; do not add sticky-selection behavior;
- selected styling still comes from `route.selected`;
- explicit `Edit route` invokes `onEditRoute(lineId)` once and uses the existing draft gate;
- deployed Bus and Metro rows expose the same target editor used before deployment;
- valid deployed target edits invoke `onSetServiceTargetHeadway` with seconds;
- deployed labels say `Estimated interval` and `Recommended`, without `required` wording that makes surplus fleet look invalid;
- `Longest wait` renders independently from the at-risk warning;
- a zero-second longest wait is not treated as missing;
- the warning contains factual wait/risk copy only and never `Add ... to recover`;
- Add bus/train is rendered from `nextVehicleCost` even when assigned fleet is at/above recommendation;
- Daily cost and other existing service readouts remain intact.

Global-pause eligibility belongs to Rust tests because `LinesPanel` has no pause input; the component only observes `nextVehicleCost`. `RuntimeController.selectRoute` already has toggle coverage, so add runtime tests only if wiring reveals a genuinely missing contract.

### Existing browser-flow assertions that must change

Before adding the new HPA-48 journey, update the current Bus/Metro route E2E expectations that encode the old deployed UI:

- deployed headway editor is absent -> now present;
- `Nominal` -> `Estimated interval`;
- `N / M required` -> separate `Fleet N` and `Recommended M` presentation;
- existing Add-vehicle flow may continue to observe a non-null `nextVehicleCost` after a purchase.

These are replacements to existing assertions, not a second E2E feature.

### Representative browser flow

Use one new Bus E2E, not duplicate Bus + Metro browser flows:

1. create a Bus line with a valid initial target and deploy its initial fleet;
2. return to the normal Lines list;
3. select the line and assert it is highlighted without opening a route draft;
4. record original fleet and current operating information;
5. edit the deployed target to another valid value and read the post-dispatch runtime snapshot rather than duplicating recommendation math in Playwright;
6. choose the deterministic fixture/target so the line is at or above its Rust recommendation;
7. assert `nextVehicleCost` is still available;
8. click Add bus once;
9. assert assigned fleet is exactly `before + 1`, original vehicles are preserved, and Standard budget falls by the pre-click Rust price;
10. assert the row refreshes Fleet/Recommended/Estimated interval/Daily cost and retains honest wait presentation without entering geometry edit.

Metro parity stays at Rust/component level.

## Alternatives rejected

### Automatically resize fleet when target changes

Rejected. It couples a cheap planning edit to purchases/removals and creates refund/retirement/re-spacing semantics. Explicit one-at-a-time purchase is clearer and keeps target editing side-effect free.

### Keep recommendation as a hard purchase cap

Rejected. The recommendation describes the fleet implied by the target interval; it should not prevent the player from intentionally buying reserve/extra capacity. Using it as a cap makes a planning estimate behave like an arbitrary fleet rule.

### Add a separate desired-fleet value

Rejected. The player already has direct one-at-a-time purchase control plus a target-derived recommendation. A second durable desired-fleet concept is unnecessary.

### Add a dedicated service-management screen

Rejected. The Lines panel already has the relevant service readouts/actions and `selectedRouteId` already gives map-linked inspection.

### Infer capacity problems from long waits

Rejected. Current waiting evidence is descriptive. Congestion, bunching, demand spikes, route shape, or capacity could all contribute. This slice does not build causal attribution.

### Build timetables, peak bands, depots, or automatic balancing

Rejected. None are required to make the existing target/fleet model operable.

## Explicit non-goals

- automatic fleet resizing;
- vehicle removal, retirement, sale, refund, or reassignment;
- durable desired-fleet count;
- timetables or peak/off-peak targets;
- depots, maintenance, crew, or inventory;
- bunching detection, holding, or re-spacing of existing vehicles;
- recommendation engine or causal service diagnosis;
- historical wait/cost dashboards;
- new service-plan/domain abstraction;
- route geometry changes beyond the existing explicit editor;
- new wait-health metric or reliability score;
- stop-level queue/line navigation (HPA-464);
- workplace demand inspection/highlighting (HPA-463);
- camera/zoom or renderer work;
- save/wire/schema migration;
- new image assets.

## Delivery

HPA-48 stays one ticket and one PR. Amend these planning docs first, then keep implementation, tests, and the representative E2E on this same branch/PR.
