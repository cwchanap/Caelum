# HPA-48 Deployed Service Tuning Implementation Plan

> **Design:** `docs/superpowers/specs/2026-09-15-deployed-service-tuning-design.md`

## Outcome

A running Bus or Metro line can be selected and tuned from the Lines panel without entering route geometry edit. The player may change the deployed target headway, read Rust's recommendation/estimated interval, and explicitly buy one additional vehicle at a time even when the current fleet already meets or exceeds the recommendation.

Raw current wait remains visible independently from the target-relative warning, and neither a target edit nor a purchase is presented as automatically solving a service problem.

Keep this on the existing HPA-628/HPA-643 seams. No new fleet manager, durable desired-fleet value, schema, gameplay intent, backend query, renderer path, or asset work.

Several current tests intentionally encode the old product contract. Replace/invert those assertions in place rather than adding contradictory coverage beside them.

## Expected intermediate state

Tasks 1-2 deliberately invert Rust contracts before Task 4 updates the UI/browser assertions that encode the old product. Focused Rust tests should be green after each Rust task, but the broader TypeScript/E2E suite may remain red on those old assertions until Task 4 is complete.

Do not chase those expected old-contract failures inside Tasks 1-3. Task 4 owns their replacement.

## Task 1 — Unlock deployed target editing in Rust

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

### 1.1 Replace the existing setup-only target contract

Update the existing integration test:

```text
target_headway_is_setup_only_and_enforces_the_minimum
```

Retain its useful assertions:

- minimum target 60 seconds applies;
- setting the same target is a no-op;
- target below `MIN_HEADWAY_SECONDS` rejects with `InvalidHeadway`;
- target edits do not change structural route revision.

Replace only the old final contract:

```text
assigned vehicle -> SetServiceTargetHeadway -> FleetAlreadyAssigned
```

with deployed-retarget behavior for Bus, and add focused Metro parity.

For the preservation case, snapshot the line and its vehicles before dispatch and compare after dispatch:

- vehicle IDs;
- itinerary/path cursor fields;
- parked position;
- passenger IDs;
- route/trip state;
- budget.

The target/recommendation may change; those live-state values must not.

Also pin:

- tighter target can raise `required_fleet` without changing assigned fleet;
- looser target can leave `assigned_fleet > required_fleet` without removing vehicles;
- second `DeployInitialFleet` still -> `FleetAlreadyAssigned`.

Run before implementation and confirm the deployed-retarget expectation fails under the current lock:

```bash
cargo test -p caelum-core --test service_control
```

### 1.2 Remove only the post-deployment target lock

In `set_service_target_headway`:

- keep line/mode resolution;
- keep the 60-second minimum;
- remove `vehicle_count > 0 -> FleetAlreadyAssigned`;
- update the comment from setup-only target to persistent planning target;
- continue changing only `target_headway_seconds`.

Do not change `deploy_initial_fleet` or wire types in this task.

### 1.3 Extend the existing wait fixture for retarget characterization

Do not create another waiter builder.

Keep these existing unit tests as formula authority:

```text
waiting_health_counts_past_target_or_low_patience_platform_waiters
waiting_health_does_not_inherit_previous_line_wait_across_transfer
```

Add one integration dispatch characterization using existing:

```text
waiting_transit_trip(...)
```

Fixture:

- current-leg wait = 90 seconds;
- initial target = 60 seconds;
- patience remains above the separate 60-second patience-risk floor.

Prove:

1. before retarget: `longest_wait_seconds == Some(90.0)` and risk count > 0;
2. dispatch target 120 seconds;
3. the same passenger/trip object is unchanged;
4. `longest_wait_seconds == Some(90.0)` remains;
5. risk count becomes 0 because only the target threshold moved.

### 1.4 Verify Rust retarget behavior

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Suggested commit:

```text
feat: allow deployed service headway retargeting
```

## Task 2 — Generalize the one-vehicle purchase rule and remove obsolete gates

**Files**

- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

The public seam remains `AddServiceVehicle` + `nextVehicleCost`. Remove only the rules that currently treat `requiredFleet` as a hard purchase cap and global pause as a blocker.

### 2.1 Replace tests that encode shortfall-only / pause-only behavior

Replace or invert these existing integration contracts:

```text
repeated_top_up_actions_stop_at_the_live_requirement
add_service_vehicle_is_a_free_no_op_while_paused
```

Also update the paused-offer assertion inside:

```text
add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet
```

Replace/invert these unit contracts in `src/service_control.rs`:

```text
active_shortfall_metric_publishes_one_vehicle_price_but_pause_hides_it
top_up_offer_requires_an_operational_deployed_shortfall
```

The helper test follows the rename below.

Resulting cases must prove:

- Bus at recommendation -> one accepted Add -> exactly one extra vehicle;
- Bus already above recommendation -> another accepted Add -> exactly one extra vehicle;
- Metro follows the same at/above-recommendation rule;
- after each accepted purchase, `next_vehicle_cost` remains available while otherwise eligible;
- insufficient Standard budget leaves fleet/budget unchanged;
- Creative accepts without deducting budget;
- inactive/disconnected retain existing rejections;
- zero-fleet/missing-target does not bypass initial deployment;
- route active + operational + globally paused still publishes `next_vehicle_cost` and accepts one Add.

### 2.2 Rename the published-offer helper and simplify dispatch

Rename:

```text
top_up_offer(...)
```

to:

```text
add_vehicle_offer(...)
```

Use it for the **metrics-published offer**. Its inputs should be only what the offer actually needs:

- route active;
- route legs/operational status;
- mode;
- assigned fleet;
- target-headway presence.

It must not take `required_fleet` or global-pause state.

A lean shape is:

```text
add_vehicle_offer(active, legs, mode, assigned_fleet, has_target)
```

and it returns the existing vehicle price iff the route is active, operational, already has a deployed fleet, and has a target headway.

In `add_service_vehicle(...)`, keep the existing typed validation directly:

- zero fleet / missing target -> existing free no-op;
- inactive -> `InactiveRoute`;
- disconnected -> `DisconnectedLeg`;
- forged target below minimum -> `InvalidHeadway`;
- purchase authorization -> existing `CostPolicy` path.

Then delete the obsolete offer re-check that currently returns `Ok(CostedMutation::free(...))` after those checks. Once shortfall/pause cease to be offer predicates, that branch is unreachable and would turn any future helper-only rule into a silent no-op.

Also delete the local:

```text
required_fleet = required_fleet(round_trip_seconds, target_headway_seconds)
```

from `add_service_vehicle(...)`; after removing the cap it is no longer consumed. Keep `round_trip_seconds` because largest-gap insertion still needs the cycle length.

Do not add a desired-fleet field, purchase intent, or service-plan abstraction.

### 2.3 Remove dead global-pause plumbing from metrics

After `next_vehicle_cost` stops using `!globally_paused`, remove the now-unused `globally_paused` parameter from:

```text
metrics(...)
```

and remove both `snapshot.paused` arguments from `service_metrics_by_line(...)` call sites.

Then re-check the existing:

```text
#[allow(clippy::too_many_arguments)]
```

With one argument removed, delete the allow if it is no longer necessary.

This cleanup is required for the repository's `cargo clippy --workspace --all-targets -- -D warnings` gate; do not leave unused cross-boundary data behind.

### 2.4 Preserve existing vehicles and largest-gap insertion

Retain/increase integration assertions proving:

- existing vehicles keep IDs, cursors, parked positions, and passengers;
- exactly one new vehicle is appended per accepted dispatch;
- new vehicle uses existing deterministic largest-gap placement;
- existing fleet is not re-spaced/rebalanced.

Do not rewrite the largest-gap algorithm. Its current unit tests remain authority for exact placement math.

### 2.5 Verify service-control behavior

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
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

Reuse existing `RuntimeController.selectRoute(routeId | null)` and `startRouteEdit(routeId)`; do not add another runtime/UI state concept.

Preserve:

- select route -> selected;
- select same route again -> clears selection;
- selection creates no draft;
- `startRouteEdit` refuses to replace an open draft.

### 3.1 Pin component interaction

Update `linesPanel.test.ts` so the primary summary calls:

```text
onSelectRoute(route.id)
```

and not `onEditRoute`.

Add/adjust an explicit `Edit route` action that calls `onEditRoute(route.id)` once.

Keep selected styling driven by `route.selected`. Do not add sticky component-local selection.

### 3.2 Restore the selection callback

Add:

```ts
onSelectRoute: (routeId: string | null) => void;
```

Change the primary row click from edit to select, with accessible name such as `Select ${route.name}`.

Add explicit `Edit route` using the unchanged edit callback.

### 3.3 Wire App to existing runtime seams

Restore the small App handler around:

```ts
runtime.selectRoute(routeId)
```

and pass it beside the existing edit handler that already reaches `startRouteEdit`.

Do not modify `createGameRuntime.ts` or runtime types unless a genuinely missing contract is discovered.

### 3.4 Verify focused UI/runtime tests

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Fallback if project filtering ignores explicit paths:

```bash
bunx vitest run tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Suggested commit:

```text
feat: separate line selection from route editing
```

## Task 4 — Make service information honest and replace existing UI/E2E contracts

**Files**

- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify only if genuinely needed: `src/runtime/runtimeSelectors.ts` and selector tests

The current view model already exposes every required field. Prefer using it as-is.

### 4.1 Replace Lines-panel assertions that encode old copy/controls

Update existing tests rather than adding contradictory cases.

Replace:

- pre-deploy `Required` -> `Recommended`;
- deployed target input absent -> present;
- `Nominal` -> `Estimated interval`;
- `2 / 3 required` style copy -> separate Fleet and Recommended values;
- `Add bus to recover` warning suffix -> factual warning only.

For deployed Bus/Metro fixtures prove:

- target editor visible and dispatches minutes * 60;
- `Estimated interval` uses `nominalHeadwaySeconds`;
- assigned Fleet and Recommended are separate;
- `Longest wait` renders whenever non-null;
- zero-second wait renders as zero;
- risk count 0 hides the warning without hiding non-null Longest wait;
- warning contains no capacity prescription;
- Add is driven only by non-null `nextVehicleCost`, including at/above recommendation;
- Daily cost remains present.

Do not add a Lines-panel global-pause test: the component has no pause input. Rust owns that eligibility.

### 4.2 Reuse one target editor before and after deployment

Reshape the service block conceptually as:

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
  at-risk warning (existing warning gate)
  Add bus/train (when nextVehicleCost non-null)
```

Reuse `headwayMinuteDrafts`, `commitHeadway`, and `headwayMinuteValue`.

Keep internal names `requiredFleet` and `nominalHeadwaySeconds`; player-facing labels only change.

### 4.3 Preserve warning eligibility; separate raw wait

Today the warning is gated by:

```text
route.status.primary === "running" && waitingAtRiskCount > 0
```

Keep that gate. HPA-48 changes the warning wording, not warning eligibility.

Render standalone `Longest wait` from `longestWaitSeconds` independently of that gate. Therefore a paused/broken deployed row may show raw Longest wait but does not show the running-service risk warning.

Add one focused `linesPanel.test.ts` case that pins this distinction.

Warning copy should be factual, e.g.:

```text
N riders at risk
```

Do not append `Add bus/train to recover`.

### 4.4 Replace existing Bus/Metro E2E selectors and copy

Update the current Bus/Metro flows before adding the new HPA-48 journey.

**Pre-deployment Bus** currently locates the recommendation with:

```text
getByText("Required")
```

and parses `N bus(es)`. Change that locator to `Recommended` while keeping the Rust-derived value assertion.

Check `tests/ui/linesPanel.test.ts` for the same pre-deploy `Required` assertion and replace it in this task.

**Deployed Bus** currently expects:

```text
Target / Nominal / Fleet
N / M required
no route-headway input
```

**Deployed Metro** encodes the same absence/copy contract.

Replace with:

- target editor remains present;
- `Estimated interval` replaces `Nominal`;
- Fleet and Recommended are separate;
- setup-only deploy controls remain absent.

Keep the existing add-vehicle flow tolerant of the post-purchase `nextVehicleCost`; under the revised rule it normally stays non-null while otherwise eligible.

### 4.5 Rebuild WASM, then verify existing UI/browser contracts

Playwright uses `reuseExistingServer: true`, so an already-running Vite server can otherwise exercise a stale pre-HPA-48 WASM artifact after Tasks 1-2 change Rust.

Explicitly rebuild before the E2E run:

```bash
bunx vitest run tests/ui/linesPanel.test.ts
bun run wasm:build
bun run test:e2e -- tests/e2e/routes.spec.ts
```

If a dev server is already running, the new browser load must see the rebuilt artifact; restart the server if the local environment does not pick the generated WASM change up.

Suggested commit:

```text
feat: polish deployed service controls
```

## Task 5 — Add one representative operating-flow E2E

**Files**

- Modify: `tests/e2e/routes.spec.ts`

Task 4 already updates existing Bus/Metro expectations. This task adds only the connected HPA-48 flow.

### 5.1 Deterministic Bus journey

Flow:

1. create Bus line;
2. set valid target and deploy initial fleet;
3. leave geometry edit mode;
4. click normal line summary;
5. assert selected/highlighted and `routeDraft === null`;
6. record original vehicle state, budget, and Rust metrics;
7. edit deployed target;
8. read post-dispatch runtime snapshot rather than recomputing recommendation math in Playwright;
9. choose deterministic target where `assignedFleet >= requiredFleet` and assert Add still offered;
10. record Rust `nextVehicleCost`;
11. click Add once;
12. assert assigned fleet == before + 1, original vehicles remain, Standard budget drops by recorded price;
13. assert Fleet / Recommended / Estimated interval / Daily cost / wait presentation refreshes;
14. assert geometry edit was never entered.

Do not use elapsed browser time to prove service improvement. This is an operating-flow test, not a causal benchmark.

Metro parity remains Rust/component coverage.

### 5.2 Rebuild WASM, then run focused E2E

```bash
bun run wasm:build
bun run test:e2e -- tests/e2e/routes.spec.ts
```

Suggested commit:

```text
test: cover deployed service tuning flow
```

## Task 6 — Regression and quality gates

No generated image/art task is required.

Run:

```bash
cargo test --workspace
bun run check
bun run test
bun run lint
bun run format:check
bun run wasm:build
bun run test:e2e
bun run build
```

`bun run lint` includes `cargo clippy --workspace --all-targets -- -D warnings`; Task 2's dead-parameter cleanup is required for this gate.

Tauri-specific code is not changing, so do not add a new Tauri harness.

## Scope guard

Stop if implementation starts asking for:

- durable desired-fleet count;
- automatic purchase/removal after target change;
- vehicle sale/refund/reassignment;
- depot/timetable/peak-band model;
- re-spacing/rebalancing existing vehicles;
- new wait/bunching/reliability metrics;
- causal diagnosis/recommendation engine;
- historical service dashboard;
- stop-level queue/line navigation (HPA-464);
- workplace demand visualization (HPA-463);
- new service-details screen;
- renderer/camera work;
- save/wire/schema changes.

Those are follow-ups, not prerequisites.

## PR rule

Continue design amendments, implementation, tests, and integration cleanup on this same HPA-48 draft PR. Do not split the work into a second implementation PR.