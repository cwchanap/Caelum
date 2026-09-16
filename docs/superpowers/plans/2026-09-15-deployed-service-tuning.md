# HPA-48 Deployed Service Tuning Implementation Plan

> **Design:** `docs/superpowers/specs/2026-09-15-deployed-service-tuning-design.md`

## Outcome

A running Bus or Metro line can be selected and tuned from the Lines panel without entering route geometry edit. The player may change the deployed target headway, read Rust's recommendation/estimated interval, and explicitly buy one additional vehicle at a time even when the current fleet already meets or exceeds the recommendation.

Raw current wait remains visible independently from target-relative warnings, and neither a target edit nor a purchase is presented as automatically solving a service problem.

Keep this on the existing HPA-628/HPA-643 service-control seams. No new fleet manager, durable desired-fleet value, schema, gameplay intent, renderer path, backend query, or asset work.

## Task 1 — Unlock deployed target editing in Rust

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

### 1.1 Replace the old lifecycle-lock test first

Find the service-control coverage that currently expects `SetServiceTargetHeadway` to return `FleetAlreadyAssigned` after deployment.

Replace that expectation with focused Bus and Metro tests proving a deployed target can change.

For the preservation case, snapshot the service and its vehicles before dispatch and compare after dispatch:

- vehicle IDs;
- itinerary/path cursor fields;
- parked position;
- passenger IDs;
- route/trip state;
- budget.

The target and derived recommendation may change; those existing live-state values must not.

Add focused assertions for:

- target `< MIN_HEADWAY_SECONDS` still -> `InvalidHeadway`;
- tighter target can raise live `required_fleet` without changing assigned fleet;
- looser target can leave `assigned_fleet > required_fleet` without removing vehicles;
- a second `DeployInitialFleet` still -> `FleetAlreadyAssigned`.

Run the focused test before implementation and confirm the new deployed-edit expectation fails for the current fleet lock.

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

### 1.3 Characterize raw wait vs target-relative warning

Add a controlled waiting fixture whose current wait is:

- above an initial 60-second target;
- below a later relaxed target;
- not independently at risk through the patience floor.

Prove before/after retargeting:

- the waiting passenger/trip is unchanged;
- `longest_wait_seconds` remains the same `Some(wait)`;
- `waiting_at_risk_count` may clear because the target threshold changed.

This locks the distinction between observed wait and warning threshold without adding a new metric.

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

The public product seam remains `AddServiceVehicle` + `nextVehicleCost`. Change only the eligibility rule that currently treats `requiredFleet` as a hard cap.

### 2.1 Replace the old no-overbuy assumption with tests

Add focused tests first for both Bus and Metro proving an active, operational deployed service can buy one vehicle when:

```text
assignedFleet >= requiredFleet
```

Cover at least these cases:

- Bus at recommendation -> one accepted Add -> assigned fleet increases by exactly one;
- Bus already above recommendation -> another accepted Add -> exactly one more vehicle;
- Metro at/above recommendation follows the same rule;
- after each accepted purchase, `next_vehicle_cost` remains available while the service remains otherwise eligible;
- insufficient Standard budget leaves fleet and budget unchanged;
- Creative accepts the purchase without deducting budget;
- inactive and disconnected routes retain their existing rejections;
- zero-fleet/missing-target service still does not use Add as an initial-deployment bypass.

Also add a global-pause case:

- route itself active and operational;
- simulation globally paused;
- `next_vehicle_cost` remains available;
- `AddServiceVehicle` still buys exactly one vehicle.

Pause is a player planning state, not a reason to disable an otherwise valid operating action.

### 2.2 Preserve insertion behavior while removing the recommendation cap

Rename the private `top_up_offer(...)` helper to a semantically accurate name such as:

```text
add_vehicle_offer(...)
```

Its eligibility should be based on:

- deployed fleet exists;
- target exists/is valid through the surrounding service contract;
- route is active;
- route is operational/connected.

Do **not** test or gate eligibility with `assigned_fleet < required_fleet`.

Remove global simulation pause from this offer gate. Keep route-level active/connected checks.

`metrics(...)` should continue publishing the same `nextVehicleCost` field; only its meaning changes from `shortfall top-up price` to `price for one currently eligible additional vehicle`.

In `add_service_vehicle(...)`:

- keep zero-fleet/missing-target behavior as the initial-deployment guard;
- keep route inactive/disconnected validation;
- keep live round-trip/cursor derivation needed by insertion;
- remove the required-fleet shortfall/no-overbuy check;
- remove the global-pause suppression;
- continue calling the existing `append_vehicle_costed(...)` path.

Do not add a new desired-fleet field, purchase intent, or public service-plan abstraction.

### 2.3 Preserve existing vehicles and largest-gap insertion

Add/retain integration assertions proving:

- existing vehicles keep their IDs, cursors, parked positions, and passengers;
- exactly one new vehicle is appended;
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

`RuntimeController.selectRoute(routeId | null)` already exists and is already covered in runtime tests. Reuse it; do not add another runtime/UI state concept.

### 3.1 Pin the interaction contract in component tests

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

Include the current route-draft gate in the shell-level coverage if needed: selecting/trying to edit another line must not silently discard or replace an open draft.

### 3.2 Restore the selection callback to LinesPanel

Add to the Lines panel props:

```ts
onSelectRoute: (routeId: string | null) => void;
```

Change the current primary `route-select` click from `onEditRoute(route.id)` to `onSelectRoute(route.id)`.

Use a clear accessible name such as `Select ${route.name}` instead of implying geometry editing.

Add one explicit `Edit route` control alongside the existing row actions. It should call the unchanged `onEditRoute(route.id)` path.

Do not make selection pause service, change simulation state, or implicitly enter geometry editing.

### 3.3 Wire App to the existing runtime seam

Add/restore the small App handler:

```ts
function handleSelectRoute(routeId: string | null): void {
  if (runtime !== null) {
    setSnapshot(runtime.selectRoute(routeId));
  }
}
```

Pass it to `LinesPanel`/the relevant HUD composition next to `onEditRoute`.

Do not modify `createGameRuntime.ts` or `runtime/types.ts` unless current code proves the existing `selectRoute` contract is missing.

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

## Task 4 — Make deployed service information honest and operable

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify only if projection changes are genuinely needed: `src/runtime/runtimeSelectors.ts`, corresponding selector tests

The current route view model already exposes `targetHeadwaySeconds`, `assignedFleet`, `requiredFleet`, `dailyOperatingCost`, `nextVehicleCost`, `nominalHeadwaySeconds`, `waitingAtRiskCount`, and `longestWaitSeconds`. Prefer using those as-is.

### 4.1 Add UI tests first

For deployed Bus and Metro fixtures:

- target input is visible;
- entering a valid whole-minute value and clicking Set calls `onSetServiceTargetHeadway(route.id, minutes * 60)` once;
- `Nominal` player-facing copy becomes `Estimated interval`;
- recommendation is shown separately from assigned fleet, e.g. `Fleet 4` + `Recommended 3`, not `4 / 3 required`;
- `Longest wait` renders whenever `longestWaitSeconds !== null`;
- `longestWaitSeconds === 0` renders as a real zero value rather than disappearing;
- `waitingAtRiskCount === 0` hides the warning but does not hide a non-null Longest wait;
- warning copy stays factual and does not say `Add bus/train to recover`;
- Add bus/train is present whenever Rust supplies non-null `nextVehicleCost`, including fixtures at/above recommendation;
- current Daily cost remains visible and updates from the ordinary route view model after a purchase.

Keep TypeScript/Svelte free of recommendation, price, or purchase-eligibility calculations.

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

### 4.4 Verify UI tests

```bash
bunx vitest run tests/ui/linesPanel.test.ts
```

Suggested commit:

```text
feat: polish deployed service controls
```

## Task 5 — Add one representative operating-flow E2E

**Files**

- Modify: `tests/e2e/routes.spec.ts`
- Reuse existing helpers; avoid adding a new E2E helper layer unless an exact helper is already missing from multiple tests.

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
13. assert the row refreshes Fleet, Recommended, Estimated interval, Daily cost, and wait presentation from current state;
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
