# HPA-645 Daily Vehicle Operating Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the daily Bus/Metro fleet cost implied by the current service plan and deduct the live charge once per game day in Standard sandbox while Creative remains budget-neutral.

**Architecture:** Add one narrow Rust `operating_cost` authority for mode constants, fleet projection, and one Standard day-boundary debit. Reuse the existing `trips` midnight substep and existing `service_control::ServiceMetrics` publication. Keep route activity separate from global simulation pause so HPA-628 top-up remains pause-suppressed while nominal daily cost remains visible. TypeScript forwards the Rust value and the existing Lines row formats it.

**Tech Stack:** Rust `caelum-core`, serde runtime wire output, TypeScript runtime selectors, Svelte 5, Vitest/Testing Library, existing Rust integration tests.

**Spec:** `docs/superpowers/specs/2026-08-19-daily-vehicle-operating-cost-design.md`

## Global Constraints

- Bus daily operating cost is exactly `$400 / vehicle / game day`.
- Metro daily operating cost is exactly `$2,500 / vehicle / game day`.
- Keep those as independent constants; do not derive them from `BUS_COST` / `METRO_COST`.
- Do not route recurring expense through `CostPolicy`; capital purchase affordability remains unchanged.
- Standard Sandbox deducts once when an actual game-day boundary is crossed and may become negative.
- Creative exposes the same nominal `dailyOperatingCost` as Standard but deducts zero.
- Campaign behavior is unchanged.
- Charge only assigned fleets on active, connected services; inactive/broken/zero-fleet services charge zero.
- A zero-fleet targeted line may **display** the required fleet's projected daily cost but must never be charged for that projected fleet.
- Do not multiply by `state.day - previous_day`; there is no `crossed_days` or skipped-day settlement rule.
- Reuse `trips::next_boundary_after`; do not add a scheduler, timer, `lastChargedDay`, proration, accrual, or history.
- Global simulation pause is not route chargeability. It freezes time only.
- `service_control::metrics` must receive route activity and global pause separately: top-up uses `active && !globally_paused`; daily cost uses route `active` only.
- Add exactly one required runtime-derived `ServiceMetrics` field: `dailyOperatingCost`.
- No snapshot schema bump. `budget` is already persisted; `serviceMetrics` remains output-only.
- TypeScript contains no `400`, `2500`, fleet multiplication, operational predicate, or economy-preset branch for this feature.
- Use existing `formatBudget` in Svelte.
- No fares, subsidies, net-profit model, finance surface, vehicle sale/withdrawal/reassignment, or generic recurring-cost framework.
- HPA-645 remains one PR: continue implementation on PR #50's branch; do not open a second implementation PR.

---

## Baseline gate

Before implementation, update the planning branch to current `origin/main` only if needed and confirm the HPA-643/HPA-628 seams still exist:

```bash
git fetch origin
git rebase origin/main

test -f crates/caelum-core/src/service_control.rs
test -f crates/caelum-core/src/trips.rs
rg "next_boundary_after|advance_tick_substep" crates/caelum-core/src/trips.rs
rg "top_up_offer|populate_snapshot_metrics|fn metrics" crates/caelum-core/src/service_control.rs
rg "BUS_COST|METRO_COST" crates/caelum-core/src/transit.rs
rg "waiting_at_risk_count|longest_wait_seconds" crates/caelum-core/src/model.rs
rg "formatBudget" src/runtime/runtimeSelectors.ts src/components/hud/panels/LinesPanel.svelte
```

Run the focused baseline:

```bash
cargo test -p caelum-core --test service_control
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts
```

Expected: PASS before HPA-645 production edits.

## File map

### Rust production

- Create `crates/caelum-core/src/operating_cost.rs` — fixed daily constants, fleet projection, assigned-fleet boundary charge.
- Modify `crates/caelum-core/src/lib.rs` — register `operating_cost` as `pub(crate)`.
- Modify `crates/caelum-core/src/trips.rs` — invoke the charge once after `sync_clock` when a substep reaches a later day.
- Modify `crates/caelum-core/src/model.rs` — add required runtime-only `ServiceMetrics.daily_operating_cost`.
- Modify `crates/caelum-core/src/service_control.rs` — publish daily cost and split route-active from global-pause inputs without changing top-up semantics.

### Rust tests

- Unit tests in `crates/caelum-core/src/operating_cost.rs` — cost constants/projection/charge semantics.
- Modify `crates/caelum-core/tests/service_control.rs` — public tick, Creative parity, coarse/fine, save/restore, route pause/broken, global pause, Bus/Metro output.
- Modify `crates/caelum-core/tests/model_wire_format.rs` — required camelCase field in exact `serviceMetrics` JSON/literals.
- Update any other direct `ServiceMetrics { ... }` literals found by `rg "ServiceMetrics \\{" crates/caelum-core`.

### TypeScript production

- Modify `src/domain/types.ts` — required `ServiceMetrics.dailyOperatingCost`.
- Modify `src/runtime/types.ts` — required `ShellServiceState.dailyOperatingCost`.
- Modify `src/runtime/runtimeSelectors.ts` — forward Rust value with neutral `0` when metrics are absent.
- Modify `src/components/hud/panels/LinesPanel.svelte` — `Est. daily cost` / `Daily cost` rows using `formatBudget`.

### TypeScript tests

Update the existing non-null service-metric/shell-service fixtures that fail compilation:

- `tests/runtime/runtimeSelectors.test.ts`
- `tests/runtime/snapshotView.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/ui/linesPanel.test.ts`

Do not pre-edit unrelated helpers whose routes use `serviceMetrics: null`; let the compiler identify any real additional literal fallout.

---

### Task 1: Add the narrow Rust operating-cost authority

**Files:**
- Create: `crates/caelum-core/src/operating_cost.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Produces: `BUS_DAILY_OPERATING_COST: i32 = 400`.
- Produces: `METRO_DAILY_OPERATING_COST: i32 = 2_500`.
- Produces: `vehicle_daily_operating_cost(mode: TransitMode) -> i32`.
- Produces: `fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32`.
- Produces: `projected_line_daily_operating_cost(active, legs, mode, assigned_fleet, required_fleet) -> i32`.
- Produces: `apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32)`.
- Consumes: `route_lifecycle::is_route_operational`.

- [ ] **Step 1: Write failing unit tests for fixed mode/fleet costs**

Create `operating_cost.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_and_fleet_daily_costs_are_fixed_and_independent() {
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Bus), 400);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Metro), 2_500);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Walk), 0);
        assert_eq!(fleet_daily_operating_cost(TransitMode::Bus, 3), 1_200);
        assert_eq!(fleet_daily_operating_cost(TransitMode::Metro, 2), 5_000);
    }
}
```

Run:

```bash
cargo test -p caelum-core mode_and_fleet_daily_costs_are_fixed_and_independent
```

Expected: FAIL because helpers/constants are not defined.

- [ ] **Step 2: Implement constants and saturating fleet multiplication**

Add:

```rust
use crate::model::{GameMode, GameSnapshot, RouteLegPath, TransitMode};
use crate::route_lifecycle::is_route_operational;

pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;

pub(crate) fn vehicle_daily_operating_cost(mode: TransitMode) -> i32 {
    match mode {
        TransitMode::Bus => BUS_DAILY_OPERATING_COST,
        TransitMode::Metro => METRO_DAILY_OPERATING_COST,
        TransitMode::Walk => 0,
    }
}

pub(crate) fn fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32 {
    let fleet = i32::try_from(fleet).unwrap_or(i32::MAX);
    vehicle_daily_operating_cost(mode).saturating_mul(fleet)
}
```

Run:

```bash
cargo test -p caelum-core mode_and_fleet_daily_costs_are_fixed_and_independent
```

Expected: PASS.

- [ ] **Step 3: Write failing projection tests**

Use a minimal connected `RouteLegPath` fixture in the module and add:

```rust
#[test]
fn projection_uses_required_fleet_before_deployment_and_assigned_fleet_after() {
    let legs = connected_legs();

    assert_eq!(
        projected_line_daily_operating_cost(true, &legs, TransitMode::Bus, 0, Some(3)),
        1_200,
    );
    assert_eq!(
        projected_line_daily_operating_cost(true, &legs, TransitMode::Bus, 2, Some(3)),
        800,
    );
}

#[test]
fn projection_is_zero_for_unconfigured_inactive_or_broken_service() {
    let connected = connected_legs();
    let broken = broken_legs();

    assert_eq!(
        projected_line_daily_operating_cost(true, &connected, TransitMode::Bus, 0, None),
        0,
    );
    assert_eq!(
        projected_line_daily_operating_cost(false, &connected, TransitMode::Bus, 2, Some(2)),
        0,
    );
    assert_eq!(
        projected_line_daily_operating_cost(true, &broken, TransitMode::Bus, 2, Some(2)),
        0,
    );
}
```

Run:

```bash
cargo test -p caelum-core projection_uses_required_fleet_before_deployment_and_assigned_fleet_after
cargo test -p caelum-core projection_is_zero_for_unconfigured_inactive_or_broken_service
```

Expected: FAIL because projection helper is missing.

- [ ] **Step 4: Implement the projection without global-pause input**

Add:

```rust
pub(crate) fn projected_line_daily_operating_cost(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> i32 {
    if assigned_fleet == 0 {
        return required_fleet
            .map(|required| fleet_daily_operating_cost(mode, required))
            .unwrap_or(0);
    }

    if !is_route_operational(active, legs) {
        return 0;
    }

    fleet_daily_operating_cost(mode, assigned_fleet)
}
```

Run the two projection tests again. Expected: PASS.

- [ ] **Step 5: Write failing boundary-charge tests**

Build snapshots from `crate::state::create_initial_snapshot()` and reuse real route/vehicle fields or a local minimal operational line fixture. Lock the recurring contract:

```rust
#[test]
fn standard_boundary_charge_subtracts_once_and_may_go_negative() {
    let mut snapshot = one_bus_snapshot();
    snapshot.budget = 399;
    snapshot.day = 1;

    apply_day_boundary_charge(&mut snapshot, 0);

    assert_eq!(snapshot.budget, -1);
}

#[test]
fn creative_reports_nominal_cost_elsewhere_but_boundary_deducts_zero() {
    let mut snapshot = one_bus_snapshot();
    snapshot.rules.economy_preset = crate::model::EconomyPreset::Creative;
    snapshot.budget = 399;
    snapshot.day = 1;

    apply_day_boundary_charge(&mut snapshot, 0);

    assert_eq!(snapshot.budget, 399);
}

#[test]
fn no_day_transition_and_campaign_are_unchanged() {
    let mut same_day = one_bus_snapshot();
    let before = same_day.budget;
    apply_day_boundary_charge(&mut same_day, same_day.day);
    assert_eq!(same_day.budget, before);

    let mut campaign = one_bus_snapshot();
    campaign.rules.game_mode = GameMode::Campaign;
    campaign.day = 1;
    let before = campaign.budget;
    apply_day_boundary_charge(&mut campaign, 0);
    assert_eq!(campaign.budget, before);
}
```

Run:

```bash
cargo test -p caelum-core standard_boundary_charge_subtracts_once_and_may_go_negative
cargo test -p caelum-core creative_reports_nominal_cost_elsewhere_but_boundary_deducts_zero
cargo test -p caelum-core no_day_transition_and_campaign_are_unchanged
```

Expected: FAIL because charge helper is missing.

- [ ] **Step 6: Implement exactly-one-boundary debit**

Add private assigned-fleet aggregation and the charge:

```rust
fn chargeable_daily_cost(state: &GameSnapshot) -> i32 {
    let bus = state.transit.routes.iter().fold(0_i32, |total, route| {
        let cost = if route.vehicle_ids.is_empty() || !is_route_operational(route.active, &route.legs) {
            0
        } else {
            fleet_daily_operating_cost(TransitMode::Bus, route.vehicle_ids.len())
        };
        total.saturating_add(cost)
    });

    state.transit.metro_lines.iter().fold(bus, |total, line| {
        let cost = if line.vehicle_ids.is_empty() || !is_route_operational(line.active, &line.legs) {
            0
        } else {
            fleet_daily_operating_cost(TransitMode::Metro, line.vehicle_ids.len())
        };
        total.saturating_add(cost)
    })
}

pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32) {
    if state.rules.game_mode != GameMode::Sandbox || state.day <= previous_day {
        return;
    }
    if state.rules.economy_preset == crate::model::EconomyPreset::Creative {
        return;
    }

    let charge = chargeable_daily_cost(state);
    if charge > 0 {
        state.budget = state.budget.saturating_sub(charge);
    }
}
```

**Do not** compute `crossed_days`; **do not** multiply the charge by `state.day - previous_day`.

Run all `operating_cost` tests:

```bash
cargo test -p caelum-core operating_cost
```

Expected: PASS.

- [ ] **Step 7: Register the module and run core tests**

In `lib.rs`:

```rust
pub(crate) mod operating_cost;
```

Run:

```bash
cargo test -p caelum-core
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add crates/caelum-core/src/operating_cost.rs crates/caelum-core/src/lib.rs
git commit -m "feat: add daily vehicle operating cost rules"
```

---

### Task 2: Charge Standard at the existing midnight boundary

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Test: `crates/caelum-core/tests/service_control.rs`

**Interfaces:**
- Consumes: `operating_cost::apply_day_boundary_charge(&mut GameSnapshot, previous_day)`.
- Preserves: `next_boundary_after` as the only day-boundary scheduler.
- Preserves: paused tick early return.

- [ ] **Step 1: Add a public-engine Standard midnight regression**

Reuse the existing connected Bus fixture in `service_control.rs`. Configure and deploy one Bus, then set the budget after deployment:

```rust
#[test]
fn standard_running_bus_pays_once_at_midnight_and_may_go_negative() {
    let mut engine = bus_route_engine();
    assert!(engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".into(),
        target_headway_seconds: 600,
    }).applied);
    assert!(engine.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".into(),
    }).applied);

    let assigned = engine.snapshot().transit.routes[0].vehicle_ids.len();
    assert_eq!(assigned, 1);
    engine.set_budget_for_test(399);
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let crossed = engine.tick(caelum_core::clock::GAME_DAY_SECONDS);

    assert!(crossed.applied);
    assert_eq!(crossed.snapshot.day, 1);
    assert_eq!(crossed.snapshot.budget, -1);
    assert_eq!(crossed.snapshot.metrics.state, caelum_core::model::MetricsState::Running);
}
```

Run:

```bash
cargo test -p caelum-core --test service_control standard_running_bus_pays_once_at_midnight_and_may_go_negative
```

Expected before the hook: FAIL with budget still 399.

- [ ] **Step 2: Hook the charge after `sync_clock`**

In `advance_tick_substep`:

```rust
let previous_day = state.day;
let mut next = state.clone();
next.time += delta_seconds;
sync_clock(&mut next);
crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
reset_daily_commute_flags(&mut next);
```

Do not modify `next_boundary_after`. Do not add a timer or persisted charged-day field.

Run the Standard test again. Expected: PASS.

- [ ] **Step 3: Add coarse-vs-split determinism regression**

Clone the same configured engine state before midnight and advance it two ways:

```rust
let mut coarse = configured_operating_cost_bus_engine();
let mut split = coarse.clone();

let coarse_result = coarse.tick(caelum_core::clock::GAME_DAY_SECONDS + 30.0);
let _ = split.tick(caelum_core::clock::GAME_DAY_SECONDS);
let split_result = split.tick(30.0);

assert_eq!(coarse_result.snapshot.time, split_result.snapshot.time);
assert_eq!(coarse_result.snapshot.day, split_result.snapshot.day);
assert_eq!(coarse_result.snapshot.budget, split_result.snapshot.budget);
```

Run the focused test. Expected: PASS only when the charge follows the existing midnight substep.

- [ ] **Step 4: Add save/restore no-double-charge regression**

After the midnight charge:

```rust
let saved = engine.snapshot_for_save();
let charged_budget = saved.budget;
let mut restored = GameEngine::from_snapshot(saved).unwrap();
assert!(restored.dispatch(GameIntent::SetPaused { paused: false }).applied);
let same_day = restored.tick(30.0);
assert_eq!(same_day.snapshot.budget, charged_budget);
```

Run the focused test. Expected: PASS with no `lastChargedDay` state.

- [ ] **Step 5: Add route pause and broken-service charge regressions**

Use existing route controls/network mutation seams:

```rust
assert!(engine.dispatch(GameIntent::SetRouteActive {
    route_id: "route-001".into(),
    active: false,
}).applied);
```

Cross the next midnight and assert no deduction. Add one representative broken-line case using the existing road removal fixture and assert no deduction there as well.

Do not add a matrix for every broken reason.

- [ ] **Step 6: Run the Rust integration gate**

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/tests/service_control.rs
git commit -m "feat: charge daily transit operating cost"
```

---

### Task 3: Publish one runtime-only daily cost without conflating global pause

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: any additional direct `ServiceMetrics { ... }` literals found by search

**Interfaces:**
- Produces: required `ServiceMetrics.daily_operating_cost: i32` → `dailyOperatingCost` on wire.
- Consumes: `operating_cost::projected_line_daily_operating_cost`.
- Preserves: HPA-628 `next_vehicle_cost` suppression while globally paused.
- Preserves: output-only `service_metrics` persistence behavior.

- [ ] **Step 1: Add the required Rust field and let compile errors reveal literal fallout**

In `ServiceMetrics`:

```rust
pub daily_operating_cost: i32,
```

Run:

```bash
cargo test -p caelum-core --no-run
```

Expected: compile failures at direct `ServiceMetrics { ... }` literals until updated. Do not add a serde default to avoid those edits.

- [ ] **Step 2: Split `metrics` route activity from global pause**

Change the signature from a single folded `active` flag to:

```rust
fn metrics(
    active: bool,
    globally_paused: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
    assigned_fleet: usize,
    target_headway_seconds: Option<u32>,
    waiting_health: WaitingHealth,
) -> Option<ServiceMetrics>
```

Keep HPA-628 top-up behavior:

```rust
let next_vehicle_cost = top_up_offer(
    active && !globally_paused,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Add HPA-645 projection using route activity only:

```rust
let daily_operating_cost = crate::operating_cost::projected_line_daily_operating_cost(
    active,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Publish it:

```rust
Some(ServiceMetrics {
    round_trip_seconds,
    assigned_fleet,
    required_fleet,
    estimated_deployment_cost,
    next_vehicle_cost,
    nominal_headway_seconds: (assigned_fleet > 0)
        .then(|| round_trip_seconds / assigned_fleet as f64),
    waiting_at_risk_count: waiting_health.waiting_at_risk_count,
    longest_wait_seconds: waiting_health.longest_wait_seconds,
    daily_operating_cost,
})
```

Update `populate_snapshot_metrics` to pass separately:

```rust
metrics(
    route.active,
    snapshot.paused,
    &route.legs,
    TransitMode::Bus,
    ...
)
```

and equivalent Metro call.

- [ ] **Step 3: Add projection tests for pre-deployment Bus and Metro**

Extend existing output assertions:

```rust
assert_eq!(
    snapshot.transit.routes[0]
        .service_metrics
        .as_ref()
        .unwrap()
        .daily_operating_cost,
    expected_required_bus_fleet as i32 * 400,
);
```

For one Metro fixture, assert `2_500 × required/assigned fleet` as appropriate. The test may use the exported constant only if the existing integration-test visibility permits it; otherwise assert the product value directly in Rust tests. Do not expose constants publicly just for integration tests.

- [ ] **Step 4: Add the load-bearing global-pause regression**

Use a deployed Bus fixture. Capture its assigned fleet, globally pause the simulation, and assert nominal cost stays present:

```rust
let assigned = engine.snapshot().transit.routes[0].vehicle_ids.len();
let paused = engine.dispatch(GameIntent::SetPaused { paused: true });
let metrics = paused.snapshot.transit.routes[0].service_metrics.as_ref().unwrap();

assert_eq!(metrics.daily_operating_cost, 400 * assigned as i32);
```

Also use/reuse the existing shortfall Bus fixture to lock HPA-628:

```rust
let paused = shortfall.dispatch(GameIntent::SetPaused { paused: true });
let metrics = paused.snapshot.transit.routes[0].service_metrics.as_ref().unwrap();
assert_eq!(metrics.next_vehicle_cost, None);
assert!(metrics.daily_operating_cost > 0);
```

This test prevents a future refactor from passing `active && !snapshot.paused` into the operating-cost projection.

- [ ] **Step 5: Add Creative nominal-parity assertion**

In the Creative public tick test from Task 2 (or a neighboring test), assert the same one-Bus nominal metric:

```rust
let before = engine.snapshot();
assert_eq!(
    before.transit.routes[0]
        .service_metrics
        .as_ref()
        .unwrap()
        .daily_operating_cost,
    400,
);

let crossed = engine.tick(caelum_core::clock::GAME_DAY_SECONDS);
assert_eq!(crossed.snapshot.budget, 399);
assert_eq!(
    crossed.snapshot.transit.routes[0]
        .service_metrics
        .as_ref()
        .unwrap()
        .daily_operating_cost,
    400,
);
```

This directly locks “Creative shows the same nominal cost; only deduction differs.”

- [ ] **Step 6: Update exact wire/literal coverage**

Find all direct literals:

```bash
rg "ServiceMetrics \\{" crates/caelum-core
```

Add `daily_operating_cost` to each.

In `model_wire_format.rs`, update the exact camelCase object with:

```json
"dailyOperatingCost": 400
```

or the fixture's correct neutral/projected value.

Keep the existing assertion that `snapshot_for_save()` omits `serviceMetrics` entirely.

- [ ] **Step 7: Run Rust gates**

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/service_control.rs crates/caelum-core/tests
git commit -m "feat: publish service daily operating cost"
```

---

### Task 4: Forward the Rust value through TypeScript

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: other compile-failing non-null service fixtures only

**Interfaces:**
- Consumes: Rust wire key `dailyOperatingCost`.
- Produces: `ShellServiceState.dailyOperatingCost`.
- Must not derive any cost locally.

- [ ] **Step 1: Add failing selector expectation**

In the existing route service selector test, add a Rust-side fixture value:

```ts
dailyOperatingCost: 1_200,
```

and assert:

```ts
expect(row.service.dailyOperatingCost).toBe(1_200);
```

Run:

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

Expected: type/expectation failure until production types/selector are updated.

- [ ] **Step 2: Add required TypeScript fields**

In `src/domain/types.ts`:

```ts
export interface ServiceMetrics {
  // existing fields
  dailyOperatingCost: number;
}
```

In `src/runtime/types.ts`:

```ts
export interface ShellServiceState {
  // existing fields
  dailyOperatingCost: number;
}
```

Do not make either optional.

- [ ] **Step 3: Forward Rust only**

In `selectServiceState`:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
```

Do not reference `route.mode`, `vehicleIds.length`, `economyPreset`, `400`, or `2500` for this value.

- [ ] **Step 4: Fix real required-field fixture fallout**

Run:

```bash
bun run check
```

Update only compile failures caused by non-null `ServiceMetrics` / `ShellServiceState` literals. Expected files include:

- `tests/runtime/snapshotView.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/ui/linesPanel.test.ts`

Use fixture-specific values; use `0` only where the fixture is deliberately neutral.

- [ ] **Step 5: Search for forbidden frontend formulas**

```bash
rg "400|2_500|2500|daily.*operating.*\*|operating.*cost.*vehicle" src tests
```

Expected production matches: labels/field names only; no TypeScript cost constants or multiplication. Test fixture values may match.

- [ ] **Step 6: Run focused frontend gates**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/snapshotView.test.ts tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/domain/types.ts src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime tests/ui/appShell.test.ts
git commit -m "feat: forward daily operating cost"
```

---

### Task 5: Render daily cost in the existing Lines blocks

**Files:**
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`

**Interfaces:**
- Consumes: `route.service.dailyOperatingCost` already formatted with existing `formatBudget`.
- No new callback/action.

- [ ] **Step 1: Add failing zero-fleet UI assertion**

Extend the existing pre-deployment Bus fixture with:

```ts
dailyOperatingCost: 1_200,
```

Assert:

```ts
expect(service).toHaveTextContent("Est. daily cost");
expect(service).toHaveTextContent("$1,200");
```

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
```

Expected: FAIL because row is not rendered.

- [ ] **Step 2: Render the pre-deployment estimate only when a requirement exists**

Inside the existing `requiredFleet !== null` section add:

```svelte
<div class="route-service-row">
  <span class="route-service-label">Est. daily cost</span>
  <span class="route-service-value">
    {formatBudget(route.service.dailyOperatingCost)}
  </span>
</div>
```

Keep it under the same `requiredFleet !== null` gate so an unconfigured line does not show an irrelevant `$0` estimate.

Run the focused test. Expected: PASS.

- [ ] **Step 3: Add failing deployed/route-paused assertions**

Use one deployed Bus fixture with `dailyOperatingCost: 800` and assert `Daily cost $800`.

Use one route-paused/inactive fixture whose Rust-owned value is `0` and assert `Daily cost $0`.

The UI test must not calculate why the value is zero.

- [ ] **Step 4: Render the deployed row**

In the existing assigned-fleet service block add:

```svelte
<div class="route-service-row">
  <span class="route-service-label">Daily cost</span>
  <span class="route-service-value">
    {formatBudget(route.service.dailyOperatingCost)}
  </span>
</div>
```

Do not special-case Creative or global pause in Svelte.

- [ ] **Step 5: Keep one Metro presentation assertion**

Set a Metro fixture to a Rust-provided value such as `5_000` and assert `$5,000` renders through the same row. No duplicate Metro component logic.

- [ ] **Step 6: Run UI gates**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
bun run check
bun run lint:svelte
bun run lint:css
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/components/hud/panels/LinesPanel.svelte tests/ui/linesPanel.test.ts
git commit -m "feat: show service daily operating cost"
```

---

### Task 6: Whole-PR verification and scope closeout

**Files:**
- Modify only if verification reveals a real HPA-645 defect.
- Do not create another PR.

- [ ] **Step 1: Run complete automated gates**

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run test:unit
bun run test:e2e
bun run format:check
bun run check
bun run lint:svelte
bun run lint:css
bun run build
```

Expected: PASS. No HPA-645-specific Playwright midnight test is required; the existing E2E suite remains a regression gate.

- [ ] **Step 2: Run scope/reuse scans**

```bash
rg "crossed_days|lastChargedDay|RecurringExpense|EconomyService|ledger|fare|subsid" crates src
rg "400|2_500|2500" src
rg "dailyOperatingCost|daily_operating_cost" crates src tests
rg "ServiceMetrics \\{" crates/caelum-core
```

Expected:

- no `crossed_days` / multi-day settlement helper;
- no `lastChargedDay` / scheduler / ledger / fare/subsidy production work;
- no frontend operating-cost constants;
- every direct Rust `ServiceMetrics` literal includes the required field.

- [ ] **Step 3: Explicitly verify the three review invariants**

Confirm test names/evidence exist for:

1. **Boundary-only charge:** no multiplier; coarse/fine and save/restore pass.
2. **Global pause split:** globally paused active Bus retains nominal `daily_operating_cost`; HPA-628 `next_vehicle_cost` is suppressed.
3. **Creative nominal parity:** Creative budget stays unchanged while the one-Bus metric remains 400.

If any is missing, add the smallest focused regression before closeout.

- [ ] **Step 4: Verify no schema/persistence expansion**

```bash
rg "SNAPSHOT_SCHEMA_VERSION" crates/caelum-core/src/model.rs
rg "daily_operating_cost|dailyOperatingCost" crates/caelum-core/src/persistence src/persistence src-tauri
```

Expected: schema number unchanged for HPA-645 and no persisted daily-cost field.

- [ ] **Step 5: Inspect final branch scope**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only HPA-645 docs, Rust operating-cost/tick/service projection, thin TS forwarding, Lines UI, and focused tests.

- [ ] **Step 6: Update PR #50 rather than opening another PR**

Keep PR #50 draft until implementation/review is ready. Update its body with implementation verification and any review resolution notes. Link/retain HPA-645 in Linear.

Do **not** create a separate implementation PR for this ticket.

---

## Final acceptance checklist

- [ ] Bus nominal cost = `$400 × fleet`.
- [ ] Metro nominal cost = `$2,500 × fleet`.
- [ ] Zero-fleet targeted service shows required-fleet projected daily cost.
- [ ] Deployed active/connected service shows assigned-fleet daily cost.
- [ ] Route pause/broken/zero-fleet charge zero.
- [ ] Global simulation pause keeps nominal daily cost visible.
- [ ] Global simulation pause still suppresses HPA-628 top-up offer.
- [ ] Standard charges once per actual midnight and can become negative.
- [ ] No `crossed_days` multiplier exists.
- [ ] Creative budget is unchanged and nominal metric equals Standard for the same fleet.
- [ ] Coarse and split ticks produce the same time/day/budget.
- [ ] Save/restore after midnight does not double-charge.
- [ ] `ServiceMetrics.dailyOperatingCost` is required runtime output only.
- [ ] `snapshot_for_save()` still omits `serviceMetrics`.
- [ ] No schema bump or persisted settlement marker.
- [ ] No TypeScript cost formula/constants.
- [ ] Lines uses existing `formatBudget` and existing service blocks.
- [ ] No fares, ledger, proration, finance screen, or recurring-cost framework.
- [ ] All workspace/unit/e2e/lint/format/build gates pass.
- [ ] All work remains in PR #50.