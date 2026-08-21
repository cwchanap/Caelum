# HPA-335 Phase 5 Closeout Implementation Plan

> Execute this plan after the planning PR is reviewed. This is a coordination closeout, not a new gameplay implementation. Do not add production behavior unless verification exposes a concrete regression that is first split into its own bounded fix task.

**Goal:** Re-verify the merged HPA-643 / HPA-645 / HPA-646 operations-and-economy loop on current `main`, record evidence against HPA-335's exit criteria, and mark HPA-335 Done without starting unproven follow-up features.

**Architecture:** No architecture change. Rust remains authoritative for route health, operating cost, trip income, and budget mutation. Svelte continues to render the existing Lines/Topbar projections. This plan reuses existing tests instead of adding an integration harness or generic closeout framework.

**Tech stack:** Rust / `caelum-core`, Svelte + TypeScript, Vitest, Playwright, Linear.

**Design:** `docs/superpowers/specs/2026-08-20-phase5-closeout-design.md`

## Constraints

- HPA-335 is the task. Do not create a new HPA-647 merely to close the coordination parent.
- Keep this as one repository PR: the planning/design PR. The closeout execution after merge is verification + Linear state only.
- Do not add a new multi-day Playwright fixture solely to combine HPA-643, HPA-645, and HPA-646.
- Do not add route-delete refunds, route profitability, revenue UI, history, undo/redo, or another diagnostic unless separate playtest evidence justifies it.
- Do not mark HPA-336 In Progress. Its real-player and product-priority activation gates remain independent of HPA-335 completion.
- If a command below exposes a real regression on `main`, leave HPA-335 open and create one bounded bug/fix task for that regression rather than folding unrelated code into this closeout.

---

### Task 1: Re-verify the operational diagnosis/action seam

**Files owned by the existing behavior:**

- `crates/caelum-core/src/service_control.rs`
- `crates/caelum-core/tests/service_control.rs`
- `src/components/hud/panels/LinesPanel.svelte`
- `tests/ui/linesPanel.test.ts`

**Step 1: Confirm HPA-646 is already in the execution baseline**

Run:

```bash
git merge-base --is-ancestor 3cce429ef4eb9118a7defc0ac6e766f3b0ceed32 HEAD
```

Expected: exit code `0`.

This prevents closing HPA-335 from an older pre-HPA-646 checkout. Do not hard-reset a newer branch merely to match this SHA; ancestry is the only requirement.

**Step 2: Run the focused HPA-643 service-control composition test**

Run:

```bash
cargo test -p caelum-core --test service_control \
  add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet \
  -- --exact
```

Expected: PASS.

The existing assertion set must continue to prove, on one authoritative snapshot:

- positive `waiting_at_risk_count`;
- non-null `longest_wait_seconds`;
- a real `required_fleet > assigned_fleet` shortfall;
- `next_vehicle_cost == Some(BUS_COST)`;
- `AddServiceVehicle` applies;
- existing vehicles are preserved;
- assigned fleet grows by one;
- budget pays one vehicle cost;
- `next_vehicle_cost` becomes `None` after the shortfall is filled.

Do **not** change this test to tick until `waiting_at_risk_count` falls. The immediate response to the recovery action is the changed service state and disappearance of the offer; passenger waiting health changes only after later simulation outcomes.

**Step 3: Run the Lines UI unit suite**

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
```

If this repository's test script does not forward a file argument, run the existing full unit suite instead:

```bash
bun run test:unit
```

Expected: PASS, including the existing route-health warning and `Add bus` / `Add train` rendering behavior.

Do not add another UI component or snapshot fixture for closeout.

---

### Task 2: Re-verify recurring operating cost and preset semantics

**Files owned by the existing behavior:**

- `crates/caelum-core/src/operating_cost.rs`
- `crates/caelum-core/src/service_control.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/tests/service_control.rs`
- `src/components/Topbar.svelte`
- `src/components/hud/panels/LinesPanel.svelte`
- `tests/ui/appShell.test.ts`
- `tests/ui/linesPanel.test.ts`

**Step 1: Re-run the focused HPA-645 contract tests**

Run:

```bash
cargo test -p caelum-core --test service_control \
  standard_daily_operating_cost_crosses_budget_below_zero_at_midnight \
  -- --exact
cargo test -p caelum-core --test service_control \
  creative_keeps_budget_across_midnight \
  -- --exact
cargo test -p caelum-core --test service_control \
  service_metrics_split_actual_and_estimated_daily_cost \
  -- --exact
cargo test -p caelum-core --test service_control \
  daily_charge_is_identical_for_coarse_and_split_ticks \
  -- --exact
```

Expected: all PASS.

Required evidence:

- Standard can cross below zero and remain Running;
- Creative budget is unchanged;
- zero-fleet setup publishes an estimate without polluting actual daily cost;
- deployed service publishes actual daily cost;
- midnight settlement is deterministic across coarse/split ticks.

**Step 2: Re-run the current frontend unit suite**

Run:

```bash
bun run test:unit
```

Expected: PASS.

This is the player-surface proof for existing Lines/Topbar projections. Do not add a dedicated finance panel or new nominal revenue readout during closeout.

---

### Task 3: Re-verify transit-income recovery and duplicate-credit protection

**Files owned by the existing behavior:**

- `crates/caelum-core/src/transit_income.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`

**Step 1: Run the complete HPA-646 unit module**

Run:

```bash
cargo test -p caelum-core --lib transit_income::tests
```

Expected: PASS, covering:

- fixed `$200` completed-transit qualification;
- transfer-once behavior;
- zero income for non-revenue trip shapes;
- recovery from negative Standard budget;
- saturating addition;
- Creative neutrality.

**Step 2: Run the trip-resolution settlement regressions**

Run:

```bash
cargo test -p caelum-core trips::tests::completed_transit_journey_credits_standard_budget_once
cargo test -p caelum-core trips::tests::creative_and_walking_completions_do_not_credit_budget
cargo test -p caelum-core trips::tests::same_resolution_pass_sums_completed_transit_journeys
cargo test -p caelum-core trips::tests::pre_existing_terminal_transit_trip_is_not_re_credited
```

Expected: all PASS.

The pre-existing-terminal regression is load-bearing closeout evidence: a restored `Arrived`/`Late` transit trip must not generate repeated income on later ticks.

**Step 3: Run the real trip lifecycle suite**

Run:

```bash
cargo test -p caelum-core --test trip_lifecycle
```

Expected: PASS, including the HPA-646 extension of the real Bus ride/alight/final-walk fixture. The final budget must remain equal across equivalent coarse and split advancement.

Do not add a sticky `usedTransit` flag or settlement marker.

---

### Task 4: Run final repository verification without adding new coverage

No production or test files should be changed by this task.

**Step 1: Run Rust workspace verification**

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

**Step 2: Run frontend/browser verification**

```bash
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run test:e2e
bun run build
```

Expected: PASS.

`bun run test:e2e` is a regression gate over the existing player journeys. Do not add an all-in-one Phase 5 browser scenario unless this run exposes a real integration hole.

**Step 3: Confirm closeout did not accidentally grow scope**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
```

Expected during closeout execution after this planning PR has merged: no implementation diff attributable to HPA-335 closeout.

If execution is performed on a work branch that contains only bookkeeping notes, inspect the diff manually and confirm there are no Rust, TypeScript, Svelte, schema, storage, dependency, or new test-harness changes.

---

### Task 5: Record the evidence and close HPA-335 in Linear

**Repository files:** none.

**Step 1: Add one closeout comment to HPA-335**

The comment should record the final command results and map them to the parent exit criteria. Keep it factual and short. Include at least:

- HPA-643: route-health warning + bounded `AddServiceVehicle` recovery action; focused service-control test green;
- HPA-645: actual/estimated operating-cost projection; Standard negative budget; Creative neutrality; midnight determinism green;
- HPA-646: `$200` completed transit income; negative-budget recovery; duplicate-credit guard; real lifecycle/coarse-split coverage green;
- full Rust, unit, browser, lint/check/build gates green;
- no additional Phase 5 feature is justified by current evidence.

Also state explicitly:

> HPA-336 remains Backlog. Closing HPA-335 clears its dependency but does not satisfy HPA-336's separate real-player testing and campaign-priority activation gates.

**Step 2: Mark HPA-335 Done**

Use Linear to transition HPA-335 from `In Progress` to `Done` only after every required verification command above is green.

**Step 3: Re-read HPA-336**

Confirm:

- state is still `Backlog`;
- no campaign implementation issue was created as part of closeout;
- its activation gates remain unchanged.

Do not move HPA-330 or HPA-336 merely because HPA-335 is complete.

---

## Completion criteria

HPA-335 closeout is complete when:

- the operational health/action seam is green on current `main`;
- recurring cost, negative Standard budget, and Creative neutrality are green;
- transit income recovery and no-double-credit behavior are green;
- normal Rust/frontend/browser quality gates are green;
- no new production feature or generic abstraction was added;
- HPA-335 has one final evidence comment and is marked Done;
- HPA-336 remains Backlog pending its independent product gates.

No second repository PR is planned for this task. After this design/plan PR is reviewed and merged, execution is verification plus Linear closeout only.
