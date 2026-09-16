# HPA-48 Deployed Service Tuning Implementation Plan

> **Design:** `docs/superpowers/specs/2026-09-15-deployed-service-tuning-design.md`

## Outcome

A running Bus or Metro line can be selected and tuned from the Lines panel without entering route geometry edit. The player may change the deployed target headway, read Rust's recommendation/estimated interval, and explicitly buy one additional vehicle at a time even when the current fleet already meets or exceeds the recommendation.

Raw current wait remains visible independently from target-relative warnings, and neither a target edit nor a purchase is presented as automatically solving a service problem.

Keep this on the existing HPA-628/HPA-643 service-control seams. No new fleet manager, durable desired-fleet value, schema, gameplay intent, renderer path, backend query, or asset work.

Several current tests intentionally encode the old product contract. Replace/invert those assertions in place rather than adding contradictory coverage beside them.

## Task 1 — Unlock deployed target editing in Rust

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

### 1.1 Replace the existing setup-only target contract

Update the existing integration test:

```text
target_headway_is_setup_only_and_enforces_the_minimum
```

Do not add a new deployed-target test while leaving its current `FleetAlreadyAssigned` assertion intact.

Retain the useful assertions already in that test:

- minimum target 60 seconds applies;
- setting the same target is a no-op;
- target below `MIN_HEADWAY_SECONDS` rejects with `InvalidHeadway`;
- target edits do not change the structural route revision.

Replace only the old final contract:

```text
assigned vehicle -> SetServiceTargetHeadway -> FleetAlreadyAssigned
```

with deployed-retarget coverage for Bus, and add focused Metro parity coverage.

For the preservation case, snapshot the service and its vehicles before dispatch and compare after dispatch:

- vehicle IDs;
- itinerary/path cursor fields;
- parked position;
- passenger IDs;
- route/trip state;
- budget.

The target and derived recommendation may change; those existing live-state values must not.

Also pin:

- tighter target can raise live `required_fleet` without changing assigned fleet;
- looser target can leave `assigned_fleet > required_fleet` without removing vehicles;
- a second `DeployInitialFleet` still -> `FleetAlreadyAssigned`.

Run the focused test before implementation and confirm the deployed-retarget expectation fails for the current fleet lock.

```bash
cargo test -p caelum-core --test service_control
```

### 1.2 Remove only the post-deployment target lock

In `service_control::set_service_target_headway`:

- keep line/mode resolution;
- keep the 60-second minimum validation;
- remove the `vehicle_count > 0 -> FleetAlreadyAssigned` branch;
- update the function comment from a pre-deployment-only target to the persistent planning target;
- continue changing only `target_headway_seconds` on the matching Bus/Metro line.

Do not change `deploy_initial_fleet` or any wire type in this task.

### 1.3 Extend the existing wait fixtures for retarget characterization

Do not create another waiter builder or wait pipeline.

Keep these existing service-control unit tests as the formula authority:

```text
waiting_health_counts_past_target_or_low_patience_platform_waiters
waiting_health_does_not_inherit_previous_line_wait_across_transfer
```

Add one integration dispatch characterization in `crates/caelum-core/tests/service_control.rs` using the existing:

```text
waiting_transit_trip(...)
```

Construct one waiter with:

- current-leg wait = 90 seconds;
- initial target = 60 seconds;
- patience remaining above the independent 60-second patience-risk floor.

Prove:

1. before retarget: `longest_wait_seconds == Some(90.0)` and `waiting_at_risk_count > 0`;
2. dispatch `SetServiceTargetHeadway` to 120 seconds;
3. the same passenger/trip object is unchanged;
4. `longest_wait_seconds == Some(90.0)` remains;
5. `waiting_at_risk_count == 0` because only the target-relative threshold moved.

This characterizes mutation behavior while leaving the existing unit tests responsible for the wait formula itself.

### 1.4 Verify Rust retarget behavior

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Suggested commit:

```text
feat: allow deployed service headway retargeting
```

## Task 2 — Generalize the existing one-vehicle purchase rule

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

The public product seam remains `AddServiceVehicle` + `nextVehicleCost`. Change only the eligibility rule that currently treats `requiredFleet` as a hard cap and global simulation pause as a blocker.

### 2.1 Replace the tests that encode shortfall-only / pause-only behavior

Replace or invert these existing integration contracts rather than adding new tests beside them:

```text
repeated_top_up_actions_stop_at_the_live_requirement
add_service_vehicle_is_a_free_no_op_while_paused
```

Also update the paused-offer assertion inside:

```text
add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet
```

That test currently creates a paused engine over the same durable state and expects `next_vehicle_cost == None`; after HPA-48 the same otherwise-active/operational route should continue publishing the offer.

Replace/invert these unit contracts in `src/service_control.rs`:

```text
active_shortfall_metric_publishes_one_vehicle_price_but_pause_hides_it
top_up_offer_requires_an_operational_deployed_shortfall
```

The second test should follow the helper rename described below.

The resulting focused cases must prove:

- Bus at recommendation -> one accepted Add -> assigned fleet increases by exactly one;
- Bus already above recommendation -> another accepted Add -> exactly one more vehicle;
- Metro at/above recommendation follows the same rule;
- after each accepted purchase, `next_vehicle_cost` remains available while the service remains otherwise eligible;
- insufficient Standard budget leaves fleet and budget unchanged;
- Creative accepts the purchase without deducting budget;
- inactive and disconnected routes retain their existing rejections;
- zero-fleet/missing-target service still does not use Add as an initial-deployment bypass;
- route active + operational + simulation globally paused still publishes `next_vehicle_cost` and accepts exactly one Add.

### 2.2 Rename one private offer helper and keep both consumers aligned

Rename:

```text
top_up_offer(...)
```

to a semantically accurate private helper such as:

```text
add_vehicle_offer(...)
```

Both existing consumers must continue to use the same helper:

- `metrics(...)` when publishing `next_vehicle_cost`;
- `add_service_vehicle(...)` when validating the live action.

Its eligibility should be based on:

- deployed fleet exists;
- route is active;
- route is operational/connected.

Target presence/minimum remains validated by the surrounding service contract before purchase proceeds.

Do **not** gate the helper with:

```text
assigned_fleet < required_fleet
```

and do **not** suppress it because the entire simulation is globally paused.

`requiredFleet` remains derived/published guidance, but no longer participates in purchase eligibility.

In `add_service_vehicle(...)`:

- keep zero-fleet/missing-target behavior as the initial-deployment guard;
- keep route inactive/disconnected validation;
- keep live round-trip/cursor derivation needed by insertion;
- remove the required-fleet shortfall/no-overbuy check;
- remove the global-pause suppression;
- continue calling the existing `append_vehicle_costed(...)` path.

Do not add a new desired-fleet field, purchase intent, or public service-plan abstraction.

### 2.3 Preserve existing vehicles and largest-gap insertion

Retain/increase integration assertions proving:

- existing vehicles keep their IDs, cursors, parked positions, and passengers;
- exactly one new vehicle is appended per accepted dispatch;
- the new vehicle follows the existing deterministic largest-gap placement path;
- no existing vehicle is re-spaced or rebalanced.

Do not rewrite or expand the existing largest-gap algorithm. Its dedicated unit tests remain the authority for exact placement math.

### 2.4 Verify service-control behavior

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Suggested commit:

```text
feat: allow explicit extra service capacity
```

## Task 3 — Separate line inspection from route geometry editing

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify only if needed: `tests/ui/appShell.test.ts`

`RuntimeController.selectRoute(routeId | null)` and `startRouteEdit(routeId)` already contain the required lifecycle semantics. Reuse them; do not add another runtime/UI state concept.

Current runtime behavior to preserve:

- `selectRoute("route-001")` selects it;
- selecting the same route again clears `selectedRouteId`;
- `selectRoute` creates no route draft;
- `startRouteEdit` is a no-op while another draft is open;
- entering route edit continues to use the existing selected-route/draft lifecycle.

### 3.1 Pin the component interaction contract

Update `linesPanel.test.ts` so the primary line summary is expected to:

```text
onSelectRoute(route.id)
```

and explicitly **not** call `onEditRoute`.

Add/adjust a second assertion for an `Edit route` button/action that calls:

```text
onEditRoute(route.id)
```

exactly once.

Keep the existing `route.selected` visual assertion so selection remains a view-model concern rather than component-local state.

Do not add a component-local sticky selection rule. The primary row inherits the existing runtime toggle semantics.

### 3.2 Restore the selection callback to LinesPanel

Add to the Lines panel props:

```ts
onSelectRoute: (routeId: string | null) => void;
```

Change the current primary `route-select` click from `onEditRoute(route.id)` to `onSelectRoute(route.id)`.

Use a clear accessible name such as `Select ${route.name}` instead of implying geometry editing.

Add one explicit `Edit route` control alongside the existing row actions. It should call the unchanged `onEditRoute(route.id)` path.

Do not make selection pause service, change simulation state, or implicitly enter geometry editing.

### 3.3 Wire App to the existing runtime seams

Add/restore the small App handler around:

```ts
runtime.selectRoute(routeId)
```

and pass it to `LinesPanel` next to the existing edit handler, which continues to call `startRouteEdit`.

Do not modify `createGameRuntime.ts` or `runtime/types.ts` unless current code proves a genuinely missing contract. The existing runtime test already covers same-route toggle behavior; do not rewrite that behavior in this slice.

### 3.4 Verify component/runtime shell tests

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

If Vitest project filtering ignores explicit paths under this script, run the direct equivalent:

```bash
bunx vitest run tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Suggested commit:

```text
feat: separate line selection from route editing
```

## Task 4 — Make deployed service information honest and update existing UI/E2E contracts

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify only if projection changes are genuinely needed: `src/runtime/runtimeSelectors.ts`, corresponding selector tests

The current route view model already exposes `targetHeadwaySeconds`, `assignedFleet`, `requiredFleet`, `dailyOperatingCost`, `nextVehicleCost`, `nominalHeadwaySeconds`, `waitingAtRiskCount`, and `longestWaitSeconds`. Prefer using those as-is.

### 4.1 Replace existing Lines-panel assertions that encode the old copy/controls

Update the existing deployed-service tests rather than layering new contradictory cases beside them.

Current assertions to invert include:

- deployed target input absent -> target input present;
- `Nominal` -> `Estimated interval`;
- `2 / 3 required` style fleet copy -> separate assigned Fleet and `Recommended` value;
- `Add bus to recover` warning suffix -> factual risk warning only.

For deployed Bus and Metro fixtures, prove:

- target input is visible;
- entering a valid whole-minute value and clicking Set calls `onSetServiceTargetHeadway(route.id, minutes * 60)` once;
- `Estimated interval` uses existing `nominalHeadwaySeconds`;
- recommendation is shown separately from assigned fleet, e.g. `Fleet 4` + `Recommended 3`;
- `Longest wait` renders whenever `longestWaitSeconds !== null`;
- `longestWaitSeconds === 0` renders as a real zero value rather than disappearing;
- `waitingAtRiskCount === 0` hides the warning but does not hide a non-null Longest wait;
- warning copy stays factual and does not say `Add bus/train to recover`;
- Add bus/train is present whenever Rust supplies non-null `nextVehicleCost`, including fixtures at/above recommendation;
- current Daily cost remains visible and updates from the ordinary route view model after a purchase.

Do not add a Lines-panel global-pause test: the component has no pause input and should continue rendering Add purely from `nextVehicleCost`. Pause eligibility is fully covered in Task 2 Rust tests.

### 4.2 Reuse one target editor before and after deployment

Reshape the service block so the same target display/editor is available regardless of `assignedFleet`.

A lean shape is:

```text
common Target + target editor
if no fleet:
  Recommended
  Est. deploy cost
  Est. daily cost
  Deploy fleet
else:
  Estimated interval
  Fleet
  Recommended
  Daily cost
  Longest wait (when non-null)
  factual at-risk warning (when > 0)
  Add bus/train offer (when nextVehicleCost is non-null)
```

Reuse the existing `headwayMinuteDrafts`, `commitHeadway`, `headwayMinuteValue`, and callback. Do not create a second headway form component unless the existing template becomes materially harder to read.

Keep internal names `requiredFleet` and `nominalHeadwaySeconds`; change player-facing labels only.

### 4.3 Decouple warning copy from purchase guidance

Change the current warning from the equivalent of:

```text
N riders at risk · longest X. Add bus to recover.
```

to factual warning-only copy, for example:

```text
N riders at risk
```

The dedicated `Longest wait` row carries the raw wait measurement and the nearby Add button carries the optional capacity action. Do not claim that a purchase resolves the warning.

No new reliability score, success toast, before/after comparison, or inferred cause is needed.

### 4.4 Update the existing Bus/Metro E2E assertions before adding a new journey

`tests/e2e/routes.spec.ts` already asserts the old deployed UI in existing Bus and Metro flows. Replace those assertions in this task:

Bus deployed flow currently expects:

```text
Target / Nominal / Fleet
N / M required
no route-headway input after deployment
```

Metro deployed flow encodes the same absence/copy contract.

Change them to assert:

- deployed target input remains present;
- `Estimated interval` replaces `Nominal`;
- assigned Fleet and Recommended are separate;
- setup-only deploy controls remain absent after deployment.

Keep the existing add-vehicle E2E tolerant of whatever Rust publishes for the next `nextVehicleCost`; under the revised rule it should normally remain non-null while the service stays eligible.

This makes the existing suite reflect HPA-48 before Task 5 adds the new operating journey.

### 4.5 Verify existing UI/browser contracts

```bash
bunx vitest run tests/ui/linesPanel.test.ts
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Suggested commit:

```text
feat: polish deployed service controls
```

## Task 5 — Add one representative operating-flow E2E

**Files**

- Modify: `tests/e2e/routes.spec.ts`
- Reuse existing helpers; avoid adding a new E2E helper layer unless an exact helper is already missing from multiple tests.

Task 4 has already updated the existing Bus/Metro deployed-service assertions. This task adds only the new connected HPA-48 operating flow.

### 5.1 Build a deterministic Bus case

Use the existing route/service fixture style to create a route whose round trip is comfortably above the 60-second minimum.

Flow:

1. create the Bus line;
2. set a valid initial target and deploy its initial fleet;
3. leave route geometry edit mode;
4. click the normal line summary;
5. assert the line becomes selected/highlighted while `snapshot.ui.routeDraft === null`;
6. record original vehicle IDs/state, budget, and current Rust metrics;
7. edit the deployed target to another valid value;
8. read the post-retarget runtime snapshot rather than deriving recommendation math in Playwright;
9. use a deterministic target where `assignedFleet >= requiredFleet` and assert the Add offer is still present;
10. record Rust-provided `nextVehicleCost`;
11. click Add bus once;
12. assert assigned fleet is exactly `before + 1`, original vehicles remain present, and Standard budget falls by the recorded Rust price;
13. assert the row refreshes Fleet, Recommended, Estimated interval, Daily cost, and honest wait presentation from current state;
14. assert geometry edit was never entered during selection/retarget/purchase.

Do not use elapsed browser time to prove a service improvement. The E2E is an operating-flow test, not a causal simulation benchmark.

Do not duplicate this browser journey for Metro; Bus/Metro parity belongs in Rust/component tests.

### 5.2 Run the focused route suite

```bash
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Suggested commit:

```text
test: cover deployed service tuning flow
```

## Task 6 — Regression and quality gates

No generated image/art task is required.

Run the normal repository gates after the focused tests are green:

```bash
cargo test --workspace
bun run check
bun run test
bun run lint
bun run format:check
bun run test:e2e
bun run build
```

Tauri-specific code is not changing, so do not add a new Tauri harness. Existing critical Tauri/host coverage must remain green through the normal suite/build gates.

## Scope guard during implementation

Stop and keep the ticket small if implementation starts asking for any of the following:

- durable desired-fleet count separate from target headway;
- automatic purchase/removal after target change;
- vehicle sale/refund/reassignment;
- depot or timetable model;
- peak/off-peak target bands;
- re-spacing/rebalancing existing vehicles;
- new wait/bunching/reliability metrics;
- causal capacity diagnosis or recommendation engine;
- historical service dashboard;
- stop-level queue/line navigation (HPA-464);
- workplace demand visualization/highlighting (HPA-463);
- new service-details page/modal;
- renderer/camera changes;
- save/wire/schema changes.

Those are follow-up product decisions, not prerequisites for this operating loop.

## PR rule

Continue implementation on this same HPA-48 branch and draft PR. Do not split design, implementation, and tests into separate PRs.
