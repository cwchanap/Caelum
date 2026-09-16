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

Current `main` already has the required primitives:

- `UiState.selectedRouteId` and `RuntimeController.selectRoute(...)` select/highlight a line without changing simulation state. Selecting the same route again already clears the selection.
- `startRouteEdit(routeId)` already owns geometry-edit entry and no-ops while another route draft is open.
- WebGPU route/vehicle emphasis and DOM map text already consume `selectedRouteId`.
- `GameIntent::SetServiceTargetHeadway` and the matching runtime command already update the line target.
- `service_control` already owns round-trip timing, `requiredFleet`, nominal headway, daily cost, waiting-health metrics, and the 60-second target floor.
- HPA-628 already added `AddServiceVehicle`, Rust-derived `nextVehicleCost`, `CostPolicy` reuse, and deterministic largest-gap insertion for the newly added vehicle.
- the Lines panel already has the target editor helpers and renders Target, Nominal, Fleet, Daily cost, wait warnings, and the one-vehicle Add action.
- `longestWaitSeconds` and `waitingAtRiskCount` already exist separately in Rust metrics and the TypeScript route view model.

The slice removes or clarifies four product locks:

1. the Lines row primary action currently enters geometry editing instead of selecting the line;
2. `set_service_target_headway` rejects any line with assigned vehicles;
3. HPA-628 currently treats `requiredFleet` as a purchase ceiling and global simulation pause as an Add-vehicle blocker;
4. the wait warning currently couples raw wait evidence to prescriptive `Add ... to recover` copy.

No new durable state, transport model, renderer path, backend query, or service-management screen is needed.

## 1. Select is inspection; Edit is explicit

Restore the existing UI-only selection path to the Lines panel:

```text
click line summary -> runtime.selectRoute(lineId) -> selectedRouteId
```

Preserve the existing runtime semantics:

- selecting a different route selects it;
- selecting the same route again clears selection;
- selection creates no route draft and dispatches no gameplay mutation.

Add a separate `Edit route` action that continues through the existing route-editor entry point. An open route draft keeps its current Save/Cancel gate; HPA-48 does not replace or silently discard it.

Do not introduce another selection state, service-details modal, or navigation manager.

## 2. Target headway remains a planning input after deployment

`targetHeadwaySeconds` remains the player's desired interval and Rust continues deriving:

```text
requiredFleet = ceil(roundTripSeconds / targetHeadwaySeconds)
```

Allow `SetServiceTargetHeadway` after deployment by removing only the assigned-fleet rejection from `set_service_target_headway`.

Keep the mutation narrow:

- resolve Bus vs Metro in Rust;
- keep the 60-second minimum and existing numeric validation;
- change only `target_headway_seconds`;
- do not add/remove/move/re-space/park/reassign vehicles;
- do not mutate passengers, route geometry, cursor state, or active trips;
- re-derive ordinary service metrics from the accepted snapshot.

`FleetAlreadyAssigned` remains valid for a second `DeployInitialFleet` attempt.

Changing the target changes the recommendation, not the fleet. Tightening may raise `requiredFleet`; loosening may leave `assignedFleet > requiredFleet`. No automatic purchase, retirement, refund, or operating-cost saving is implied.

## 3. Recommended fleet is guidance, not a purchase ceiling

The player may explicitly buy one additional vehicle when:

- a deployed fleet exists (`assignedFleet > 0`);
- a valid target exists;
- the route itself is active;
- the route is operational/connected;
- the existing purchase policy permits the spend.

`assignedFleet < requiredFleet` is no longer an eligibility rule. `requiredFleet` remains planning guidance for the target interval, but the player may intentionally run extra capacity.

Keep the public seams:

- `AddServiceVehicle` remains the gameplay intent;
- `nextVehicleCost` remains the Rust-owned published offer/price;
- current Bus/Metro prices and `CostPolicy` remain authoritative;
- one accepted dispatch adds exactly one correctly typed vehicle.

Rename the private `top_up_offer(...)` helper to a neutral name such as `add_vehicle_offer(...)` and use it to publish `nextVehicleCost` from service metrics. The helper no longer needs `requiredFleet` or global-pause state.

`AddServiceVehicle` itself keeps the existing typed validation for zero fleet/missing target, inactive service, disconnected service, invalid target, purchase authorization, and insertion. Once the shortfall/pause gates are removed, do not keep a redundant offer re-check that can only silently return a free no-op after those typed checks have already passed.

### Preserve existing insertion behavior

Keep HPA-628's deterministic largest-gap insertion for the newly purchased vehicle:

- preserve all existing vehicle IDs, cursors, parked positions, and passengers;
- place only the new vehicle at the midpoint of the current largest cycle gap;
- do not move/re-space/rebalance existing vehicles;
- do not add a fleet optimizer.

### Zero fleet and route failures

A zero-fleet route still uses `DeployInitialFleet`; `AddServiceVehicle` is not an alternate first-deployment path.

A route that is itself inactive or broken/disconnected still cannot buy through Add.

### Global simulation pause

Global simulation pause is a planning state, not a line-operating lock. An otherwise active, operational deployed service should continue to publish `nextVehicleCost` and accept one Add action while the simulation is globally paused.

This does not change route-level active/broken eligibility.

## 4. Operating information stays descriptive

Keep one Lines-panel row model and use existing Rust-owned values.

For a deployed line show:

- editable **Target**;
- **Estimated interval** using existing `nominalHeadwaySeconds`;
- current assigned **Fleet**;
- **Recommended** fleet using existing `requiredFleet`;
- current **Daily cost**;
- **Longest wait** whenever `longestWaitSeconds !== null`;
- the existing at-risk warning when its existing warning eligibility is met;
- Add bus/train with Rust-owned `nextVehicleCost` when eligible.

Keep internal/wire names such as `requiredFleet` and `nominalHeadwaySeconds`; only player-facing copy changes.

A compact deployed presentation can read:

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

Do not render `4 / 3 required`; surplus fleet is a valid player choice.

For a zero-fleet line, rename the existing player-facing `Required` recommendation to `Recommended` while retaining the existing deployment-cost, estimated-daily-cost, and Deploy fleet flow.

### Raw wait and warning are different signals

`longestWaitSeconds` is descriptive current wait evidence. `waitingAtRiskCount` is warning state derived relative to target/patience rules.

Keep them separate:

- show `Longest wait` whenever `longestWaitSeconds !== null`, including on paused/broken deployed rows where current wait evidence still exists;
- `null` means no current waiter and is distinct from a measured zero-second wait;
- a real zero-second value renders as zero rather than disappearing;
- changing the target may clear the risk count but must not mutate/hide the same raw wait;
- a successful purchase refreshes ordinary metrics but does not display `problem solved` or similar causal language.

Preserve the current at-risk warning eligibility: the warning remains gated to a line whose route status is `running` and whose `waitingAtRiskCount > 0`. HPA-48 changes the warning copy, not this eligibility rule. Paused/broken rows may still show raw `Longest wait`, but not the running-service risk warning.

Remove the current warning suffix `Add bus/train to recover`. The Add button is an independent player action; a long wait alone is not a diagnosis that capacity is the cause.

No new reliability score, historical series, causal diagnosis, or wait metric is justified.

## State and persistence

No new authoritative state is needed. Existing fields are sufficient:

- `targetHeadwaySeconds` — desired/planning interval;
- `vehicleIds` — assigned fleet;
- `serviceMetrics.requiredFleet` — recommendation;
- `serviceMetrics.nominalHeadwaySeconds` — estimated interval;
- `serviceMetrics.nextVehicleCost` — one-vehicle offer/price;
- `serviceMetrics.longestWaitSeconds` — raw current wait;
- `serviceMetrics.waitingAtRiskCount` — warning count;
- `selectedRouteId` — UI-only inspection selection.

Therefore there is no schema bump, migration, new save field, new gameplay intent, compatibility alias, backend query, or renderer/presentation schema change.

## Rejection and stale-action behavior

`SetServiceTargetHeadway` keeps:

- missing line -> `RouteNotFound`;
- target below 60 seconds -> `InvalidHeadway`;
- assigned fleet -> no longer a rejection.

`AddServiceVehicle` keeps:

- zero fleet or missing target -> existing free no-op preserving initial deployment;
- inactive route -> `InactiveRoute`;
- disconnected route -> `DisconnectedLeg`;
- invalid forged target -> `InvalidHeadway`;
- global simulation pause alone -> still eligible;
- fleet at/above recommendation -> still eligible;
- insufficient Standard budget -> atomic `InsufficientBudget` with unchanged state;
- Creative -> existing non-deducting purchase behavior;
- accepted dispatch -> exactly one new vehicle using existing largest-gap placement.

Do not add a new rejection family.

## Risks and deliberate trade-offs

Removing the recommendation ceiling makes Add intentionally open-ended.

- **Purchases are irreversible in this slice.** There is no vehicle sale/retirement/removal action, so an over-purchased active line cannot reduce assigned fleet through HPA-48.
- **Standard mode is budget-limited, not recommendation-limited.** Extra vehicles consume the normal purchase price and increase the line's ordinary recurring operating liability while active.
- **Creative mode has no monetary brake.** Repeated Add actions can grow a fleet indefinitely from a product-rule perspective.

This is accepted for HPA-48 because adding removal now introduces new choices about which vehicle leaves service, passenger handling, refunds, and placement/rebalancing semantics. Do not hide those decisions inside this slice.

If playtesting shows irreversible over-purchase is a real usability problem, the named follow-up is an explicit one-vehicle removal/retirement control (for example a future `RemoveServiceVehicle` intent) with its own passenger/refund semantics. It is not a prerequisite for deployed tuning.

## Test strategy

Replace/invert existing tests that encode the old product rather than adding contradictory cases beside them.

Rust coverage must prove:

- deployed Bus and Metro targets can change while preserving live state;
- target floor and second-initial-deploy protections remain;
- recommendation changes do not resize the fleet;
- Bus/Metro can buy at or above recommendation;
- successive valid Add actions remain available;
- global simulation pause does not suppress the offer/action;
- inactive/disconnected/zero-fleet/missing-target behavior remains correct;
- Standard insufficient budget is atomic and Creative remains non-deducting;
- existing vehicles remain unchanged while the new vehicle uses largest-gap insertion.

Use the existing wait fixtures for one retarget characterization: a waiter at 90 seconds is at risk under target 60, then target 120 clears the target-relative warning while the same trip and `longest_wait_seconds == Some(90.0)` remain unchanged.

UI/browser coverage must update both old pre-deploy/deployed copy contracts and add one Bus operating journey. Metro parity stays at Rust/component level.

## Alternatives rejected

### Automatically resize fleet when target changes

Rejected. It couples a cheap planning edit to purchases/removals and creates refund/retirement/re-spacing semantics.

### Keep recommendation as a hard purchase cap

Rejected. The recommendation describes the fleet implied by the target interval; it should not prevent intentional reserve/extra capacity.

### Add a separate desired-fleet value

Rejected. One-at-a-time purchase plus target-derived recommendation is sufficient for this slice.

### Add vehicle removal in the same PR

Rejected. It is a real product capability, but requires passenger/refund/which-vehicle semantics that are not necessary to unlock deployed tuning.

### Add a dedicated service-management screen

Rejected. The Lines panel and existing selection state already cover the operating loop.

### Infer capacity problems from long waits

Rejected. Wait evidence is descriptive; congestion, bunching, demand, route shape, or capacity may contribute.

### Timetables, peak bands, depots, or automatic balancing

Rejected. None are required for this loop.

## Explicit non-goals

- automatic fleet resizing;
- vehicle removal, retirement, sale, refund, or reassignment;
- durable desired-fleet count;
- timetables or peak/off-peak targets;
- depots, maintenance, crew, or inventory;
- bunching detection, holding, or re-spacing existing vehicles;
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

HPA-48 stays one ticket and one PR. Planning amendments, implementation, focused tests, the representative E2E, and necessary integration cleanup remain on this branch/PR.