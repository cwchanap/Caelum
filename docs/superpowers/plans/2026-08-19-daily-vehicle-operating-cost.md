# HPA-645 Daily Vehicle Operating Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the daily Bus/Metro fleet cost implied by the current service plan and deduct the live charge once per game day in Standard sandbox while Creative remains budget-neutral.

**Architecture:** Add one focused Rust `operating_cost` module for fixed mode costs, fleet multiplication, line projection, and day-boundary deduction. Reuse `trips`' existing exact midnight substep instead of adding accounting state or a scheduler; extend runtime-only `ServiceMetrics` with one Rust-owned `dailyOperatingCost`, forward it through the existing TypeScript selector, and render one row in each existing Lines service block.

**Tech Stack:** Rust `caelum-core`, serde wire contracts, TypeScript runtime selectors, Svelte 5, Vitest/Testing Library, existing cargo/bun verification scripts.

**Spec:** `docs/superpowers/specs/2026-08-19-daily-vehicle-operating-cost-design.md`

## Global Constraints

- Single PR for HPA-645. Continue implementation on this planning branch/PR; do not open a second implementation PR.
- Bus daily operating cost is exactly `$400` per assigned/planned vehicle per game day.
- Metro daily operating cost is exactly `$2,500` per assigned/planned vehicle per game day.
- The constants are explicit tuning values; do not derive them dynamically from purchase prices or add an editable rate.
- A deployed line is chargeable only when `route_lifecycle::is_route_operational(route.active, legs)` is true and its assigned fleet is non-zero.
- A zero-fleet line is never charged, but when `requiredFleet` is derivable it publishes the projected required-fleet daily cost before deployment.
- Standard sandbox deducts at the game-day boundary even when the result is a negative budget; Creative deducts zero.
- Campaign mode is unchanged by this slice.
- Recurring cost must not use `CostQuote::authorize` / `AuthorizedCost::apply_to`; those preserve capital-purchase affordability and must remain unchanged.
- Reuse the existing day boundary in `trips::next_boundary_after`; do not add a scheduler, timer, persisted `lastChargedDay`, settlement record, or active-time accumulator.
- Boundary billing is not prorated. No refunds or partial-day charges.
- Use saturating integer arithmetic for fleet multiplication, total charge accumulation, and budget subtraction.
- Add exactly one required runtime-only `ServiceMetrics` field: `dailyOperatingCost` / `daily_operating_cost`.
- `dailyOperatingCost` is nominal and identical in Standard and Creative; TypeScript must not reproduce economy-preset behavior or cost constants.
- No snapshot schema bump. Save normalization must continue to omit `serviceMetrics`; the resulting `budget` already persists canonically.
- Route-level pause makes deployed daily cost zero; global simulation pause adds no accounting state and cannot cross a day boundary while paused.
- No fares, subsidies, revenue, net-profit calculation, ledger, finance/dashboard UI, history, loan/bankruptcy rule, fleet sale/withdrawal/reassignment, or generic economy framework.

---

## Baseline gate

Before implementation, update this branch to the latest merged `main` and verify the HPA-643/HPA-628 seams are present:

```bash
git fetch origin
git rebase origin/main

rg "BUS_COST|METRO_COST" crates/caelum-core/src/transit.rs
rg "waiting_at_risk_count|next_vehicle_cost|populate_snapshot_metrics" crates/caelum-core/src/service_control.rs
rg "next_day_boundary|advance_tick_substep" crates/caelum-core/src/trips.rs
rg "longestWaitSeconds" src tests
```

Run the focused baseline:

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts
```

Expected: all pass before HPA-645 edits.

## File map

### Rust production

- Create: `crates/caelum-core/src/operating_cost.rs` — fixed Bus/Metro daily cost authority, fleet multiplication, line projection, and day-boundary Standard deduction.
- Modify: `crates/caelum-core/src/lib.rs` — register `operating_cost` as `pub(crate)`.
- Modify: `crates/caelum-core/src/trips.rs` — call the operating-cost boundary hook immediately after time/day synchronization in `advance_tick_substep`.
- Modify: `crates/caelum-core/src/model.rs` — add required runtime-only `ServiceMetrics.daily_operating_cost: i32`.
- Modify: `crates/caelum-core/src/service_control.rs` — publish projected/current daily operating cost for Bus/Metro while preserving global-pause suppression of the existing top-up offer.

### Rust tests

- Add unit tests in `crates/caelum-core/src/operating_cost.rs` for constants, projection, Standard/Creative/campaign/no-boundary semantics, and negative budget.
- Modify: `crates/caelum-core/tests/service_control.rs` — reuse the existing real Bus/Metro fixtures to lock public day-boundary charging, coarse/fine determinism, save/restore no-double-charge, and service-output values.
- Modify: `crates/caelum-core/tests/model_wire_format.rs` — update direct `ServiceMetrics` literals and exact camelCase JSON with `dailyOperatingCost`.
- Update any other direct Rust `ServiceMetrics { ... }` literal found by the required-field compiler fallout; do not add serde defaults to avoid edits.

### TypeScript production

- Modify: `src/domain/types.ts` — add required `ServiceMetrics.dailyOperatingCost: number`.
- Modify: `src/runtime/types.ts` — add required `ShellServiceState.dailyOperatingCost: number`.
- Modify: `src/runtime/runtimeSelectors.ts` — forward Rust's field with neutral `0` when derived metrics are absent.
- Modify: `src/components/hud/panels/LinesPanel.svelte` — render `Est. daily cost` before deployment and `Daily cost` after deployment using `formatBudget`.

### TypeScript tests with current non-null service literals

Update the required field in:

- `tests/runtime/runtimeSelectors.test.ts`;
- `tests/runtime/snapshotView.test.ts`;
- `tests/runtime/gameRuntime.test.ts`;
- `tests/ui/appShell.test.ts`;
- `tests/ui/linesPanel.test.ts`.

Use compiler/search fallout to catch any additional non-null literals:

```bash
rg "longestWaitSeconds:" src tests
rg "ServiceMetrics \{" crates/caelum-core
```

Do not edit fixtures that only use `serviceMetrics: null` unless a real compile failure proves they need it.

---

### Task 1: Add the focused operating-cost authority

**Files:**
- Create: `crates/caelum-core/src/operating_cost.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Produces: `BUS_DAILY_OPERATING_COST: i32 = 400`.
- Produces: `METRO_DAILY_OPERATING_COST: i32 = 2_500`.
- Produces: `vehicle_daily_operating_cost(mode: TransitMode) -> i32`.
- Produces: `fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32`.
- Produces: `projected_line_daily_operating_cost(active: bool, legs: &[RouteLegPath], mode: TransitMode, assigned_fleet: usize, required_fleet: Option<usize>) -> i32`.
- Produces: `apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32)`.
- Depends on: existing `EconomyPreset`, `GameMode`, `GameSnapshot`, `RouteLegPath`, `TransitMode`, and `route_lifecycle::is_route_operational`.

- [ ] **Step 1: Register the module and write failing pure-rule tests**

Add to `crates/caelum-core/src/lib.rs` next to the other crate-private feature modules:

```rust
pub(crate) mod operating_cost;
```

Create `crates/caelum-core/src/operating_cost.rs` with imports plus this test module first:

```rust
#[cfg(test)]
mod tests {
    use super::{
        apply_day_boundary_charge, fleet_daily_operating_cost,
        projected_line_daily_operating_cost, vehicle_daily_operating_cost,
        BUS_DAILY_OPERATING_COST, METRO_DAILY_OPERATING_COST,
    };
    use crate::model::{
        EconomyPreset, GameMode, RouteLegPath, RouteLegStatus, ServiceDirection,
        TransitMode,
    };

    fn connected_leg() -> RouteLegPath {
        RouteLegPath {
            from_waypoint_id: "a".into(),
            to_waypoint_id: "b".into(),
            direction: ServiceDirection::Loop,
            kind: crate::model::RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: None,
            last_valid_path: None,
            estimated_seconds: None,
            failure_reason: None,
        }
    }

    #[test]
    fn vehicle_and_fleet_daily_costs_use_fixed_mode_values() {
        assert_eq!(BUS_DAILY_OPERATING_COST, 400);
        assert_eq!(METRO_DAILY_OPERATING_COST, 2_500);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Bus), 400);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Metro), 2_500);
        assert_eq!(vehicle_daily_operating_cost(TransitMode::Walk), 0);
        assert_eq!(fleet_daily_operating_cost(TransitMode::Bus, 3), 1_200);
        assert_eq!(fleet_daily_operating_cost(TransitMode::Metro, 2), 5_000);
    }

    #[test]
    fn projection_uses_required_fleet_before_deploy_and_running_fleet_after() {
        let legs = vec![connected_leg()];
        assert_eq!(
            projected_line_daily_operating_cost(true, &legs, TransitMode::Bus, 0, Some(3)),
            1_200
        );
        assert_eq!(
            projected_line_daily_operating_cost(true, &legs, TransitMode::Bus, 0, None),
            0
        );
        assert_eq!(
            projected_line_daily_operating_cost(true, &legs, TransitMode::Metro, 2, Some(3)),
            5_000
        );
        assert_eq!(
            projected_line_daily_operating_cost(false, &legs, TransitMode::Bus, 3, Some(3)),
            0
        );

        let mut broken = legs.clone();
        broken[0].status = RouteLegStatus::Disconnected;
        assert_eq!(
            projected_line_daily_operating_cost(true, &broken, TransitMode::Bus, 3, Some(3)),
            0
        );
    }
}
```

Run:

```bash
cargo test -p caelum-core operating_cost::tests::vehicle_and_fleet_daily_costs_use_fixed_mode_values
cargo test -p caelum-core operating_cost::tests::projection_uses_required_fleet_before_deploy_and_running_fleet_after
```

Expected initially: compile failure because the four functions/constants do not exist.

- [ ] **Step 2: Implement fixed costs and projection**

Above the test module, implement:

```rust
use crate::model::{EconomyPreset, GameMode, GameSnapshot, RouteLegPath, TransitMode};
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
    fleet.saturating_mul(vehicle_daily_operating_cost(mode))
}

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

Run the two tests from Step 1 again.

Expected: PASS.

- [ ] **Step 3: Add failing boundary-deduction unit tests**

Append tests that build the smallest canonical snapshot and insert one chargeable Bus route plus vehicle IDs. Use actual `Route` values so the charge predicate reads the same state production uses:

```rust
fn standard_snapshot_with_bus_fleet(fleet: usize) -> crate::model::GameSnapshot {
    let mut snapshot = crate::state::create_initial_snapshot();
    snapshot.rules.game_mode = GameMode::Sandbox;
    snapshot.rules.economy_preset = EconomyPreset::Standard;
    snapshot.day = 1;
    snapshot.budget = 399;
    snapshot.transit.routes.push(crate::model::Route {
        id: "route-001".into(),
        name: "Bus".into(),
        color: "#111111".into(),
        stop_ids: vec![],
        vehicle_ids: (0..fleet).map(|index| format!("vehicle-{index}" )).collect(),
        active: true,
        pattern: crate::model::ServicePattern::Loop,
        revision: 1,
        legs: vec![connected_leg()],
        path_broken: false,
        target_headway_seconds: Some(600),
        service_metrics: None,
    });
    snapshot
}

#[test]
fn standard_boundary_charge_can_make_budget_negative() {
    let mut snapshot = standard_snapshot_with_bus_fleet(1);
    apply_day_boundary_charge(&mut snapshot, 0);
    assert_eq!(snapshot.budget, -1);
}

#[test]
fn creative_campaign_and_same_day_do_not_deduct() {
    let base = standard_snapshot_with_bus_fleet(1);

    let mut creative = base.clone();
    creative.rules.economy_preset = EconomyPreset::Creative;
    apply_day_boundary_charge(&mut creative, 0);
    assert_eq!(creative.budget, 399);

    let mut campaign = base.clone();
    campaign.rules.game_mode = GameMode::Campaign;
    apply_day_boundary_charge(&mut campaign, 0);
    assert_eq!(campaign.budget, 399);

    let mut same_day = base;
    apply_day_boundary_charge(&mut same_day, 1);
    assert_eq!(same_day.budget, 399);
}
```

If `Route` requires an additional field on current `main`, populate that required field explicitly rather than adding a default/compatibility helper.

Run:

```bash
cargo test -p caelum-core standard_boundary_charge_can_make_budget_negative
cargo test -p caelum-core creative_campaign_and_same_day_do_not_deduct
```

Expected initially: compile failure because `apply_day_boundary_charge` does not exist.

- [ ] **Step 4: Implement the day-boundary charge without affordability authorization**

Add private charge aggregation and the public crate-level hook:

```rust
fn chargeable_daily_operating_cost(state: &GameSnapshot) -> i32 {
    let bus = state
        .transit
        .routes
        .iter()
        .filter(|route| is_route_operational(route.active, &route.legs))
        .fold(0_i32, |total, route| {
            total.saturating_add(fleet_daily_operating_cost(
                TransitMode::Bus,
                route.vehicle_ids.len(),
            ))
        });

    state
        .transit
        .metro_lines
        .iter()
        .filter(|line| is_route_operational(line.active, &line.legs))
        .fold(bus, |total, line| {
            total.saturating_add(fleet_daily_operating_cost(
                TransitMode::Metro,
                line.vehicle_ids.len(),
            ))
        })
}

pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32) {
    if state.rules.game_mode != GameMode::Sandbox || state.day <= previous_day {
        return;
    }
    if state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }

    let daily_cost = chargeable_daily_operating_cost(state);
    let crossed_days = i32::try_from(state.day - previous_day).unwrap_or(i32::MAX);
    let total_charge = daily_cost.saturating_mul(crossed_days);
    state.budget = state.budget.saturating_sub(total_charge);
}
```

Do **not** call `CostPolicy::quote`, `authorize`, or `AuthorizedCost::apply_to` here.

Run:

```bash
cargo test -p caelum-core operating_cost::tests
cargo fmt --all -- --check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add crates/caelum-core/src/lib.rs crates/caelum-core/src/operating_cost.rs
git commit -m "feat: add daily vehicle operating cost rules"
```

---

### Task 2: Attach Standard deduction to the existing midnight substep

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`

**Interfaces:**
- Consumes: `operating_cost::apply_day_boundary_charge(&mut GameSnapshot, previous_day: u32)` from Task 1.
- Preserves: current `next_boundary_after` day-boundary scheduling, objective/trip ordering, pause behavior, and coarse/fine tick determinism.
- Produces: public-engine proof that Standard can cross negative, Creative is neutral, and restore does not double-charge.

- [ ] **Step 1: Add a one-bus deployed fixture to the existing integration test**

Near the existing Bus fixture helpers in `crates/caelum-core/tests/service_control.rs` add:

```rust
use caelum_core::clock::GAME_DAY_SECONDS;
use caelum_core::model::MetricsState;

fn one_bus_service_engine() -> GameEngine {
    let mut engine = bus_route_engine();
    let target = engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".to_string(),
        target_headway_seconds: 600,
    });
    assert!(target.applied, "fixture target should apply: {target:?}");
    let deployed = engine.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert!(deployed.applied, "fixture fleet should deploy: {deployed:?}");
    assert_eq!(engine.snapshot().transit.routes[0].vehicle_ids.len(), 1);
    engine
}

fn with_economy_preset(engine: &GameEngine, preset: EconomyPreset) -> GameEngine {
    let mut saved = engine.snapshot_for_save();
    saved.rules.economy_preset = preset;
    GameEngine::from_snapshot(saved).expect("fixture snapshot should restore")
}
```

Keep the existing `EconomyPreset` import; add only missing imports.

- [ ] **Step 2: Write failing public-engine boundary tests**

Add:

```rust
#[test]
fn standard_daily_operating_cost_charges_once_and_can_cross_negative() {
    let mut engine = one_bus_service_engine();
    engine.set_budget_for_test(399);
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let result = engine.tick(GAME_DAY_SECONDS);

    assert!(result.applied);
    assert_eq!(result.snapshot.day, 1);
    assert_eq!(result.snapshot.budget, -1);
    assert_eq!(result.snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn creative_daily_operating_cost_is_visible_but_budget_neutral_on_tick() {
    let standard = one_bus_service_engine();
    let mut creative = with_economy_preset(&standard, EconomyPreset::Creative);
    creative.set_budget_for_test(399);
    assert!(creative.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let result = creative.tick(GAME_DAY_SECONDS);

    assert!(result.applied);
    assert_eq!(result.snapshot.day, 1);
    assert_eq!(result.snapshot.budget, 399);
}
```

Run:

```bash
cargo test -p caelum-core --test service_control standard_daily_operating_cost_charges_once_and_can_cross_negative
cargo test -p caelum-core --test service_control creative_daily_operating_cost_is_visible_but_budget_neutral_on_tick
```

Expected initially: the Standard test fails with budget `399` because the tick pipeline does not call the new hook. Creative remains unchanged for the wrong reason until the hook exists.

- [ ] **Step 3: Hook the charge immediately after clock synchronization**

In `trips::advance_tick_substep`, replace the opening with:

```rust
fn advance_tick_substep(
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
    delta_seconds: f64,
) -> GameSnapshot {
    let previous_day = state.day;
    let mut next = state.clone();
    next.time += delta_seconds;
    sync_clock(&mut next);
    crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
    reset_daily_commute_flags(&mut next);

    let vehicle_state = transit::tick_vehicles(&next, flow, delta_seconds);
    // existing remainder unchanged
```

Do not change `next_boundary_after`; it already schedules exact midnight.

Run the two tests from Step 2.

Expected: PASS.

- [ ] **Step 4: Add coarse/fine determinism and no-double-charge restore coverage**

Add:

```rust
#[test]
fn daily_operating_cost_is_tick_granularity_independent() {
    let mut coarse = one_bus_service_engine();
    coarse.set_budget_for_test(5_000);
    assert!(coarse.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let mut split = GameEngine::from_snapshot(coarse.snapshot_for_save()).unwrap();
    assert!(split.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let coarse_result = coarse.tick(GAME_DAY_SECONDS + 10.0);
    assert!(split.tick(GAME_DAY_SECONDS - 10.0).applied);
    let split_result = split.tick(20.0);

    assert_eq!(coarse_result.snapshot.time, split_result.snapshot.time);
    assert_eq!(coarse_result.snapshot.day, split_result.snapshot.day);
    assert_eq!(coarse_result.snapshot.budget, split_result.snapshot.budget);
}

#[test]
fn restored_charged_boundary_does_not_charge_again_before_next_day() {
    let mut engine = one_bus_service_engine();
    engine.set_budget_for_test(1_000);
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let charged = engine.tick(GAME_DAY_SECONDS);
    assert_eq!(charged.snapshot.budget, 600);

    let saved = engine.snapshot_for_save();
    let mut restored = GameEngine::from_snapshot(saved).unwrap();
    assert!(restored.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let next = restored.tick(1.0);

    assert_eq!(next.snapshot.day, 1);
    assert_eq!(next.snapshot.budget, 600);
}
```

Run:

```bash
cargo test -p caelum-core --test service_control daily_operating_cost_is_tick_granularity_independent
cargo test -p caelum-core --test service_control restored_charged_boundary_does_not_charge_again_before_next_day
```

Expected: PASS.

- [ ] **Step 5: Lock paused/broken service as zero-charge at the module seam**

Extend the Task 1 unit tests rather than creating another public-engine topology mutation scenario. Add one inactive assertion and one disconnected-leg assertion around `apply_day_boundary_charge`, using the same `standard_snapshot_with_bus_fleet` fixture:

```rust
#[test]
fn inactive_or_broken_service_is_not_charged() {
    let mut inactive = standard_snapshot_with_bus_fleet(1);
    inactive.transit.routes[0].active = false;
    apply_day_boundary_charge(&mut inactive, 0);
    assert_eq!(inactive.budget, 399);

    let mut broken = standard_snapshot_with_bus_fleet(1);
    broken.transit.routes[0].legs[0].status = RouteLegStatus::Disconnected;
    apply_day_boundary_charge(&mut broken, 0);
    assert_eq!(broken.budget, 399);
}
```

Run:

```bash
cargo test -p caelum-core operating_cost::tests
cargo test -p caelum-core --test service_control
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add crates/caelum-core/src/operating_cost.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/service_control.rs
git commit -m "feat: charge operating cost at day rollover"
```

---

### Task 3: Publish the Rust-owned daily cost through `ServiceMetrics`

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify: any other compiler-identified direct Rust `ServiceMetrics { ... }` literal

**Interfaces:**
- Consumes: `operating_cost::projected_line_daily_operating_cost(...)` from Task 1.
- Produces: required Rust/wire field `ServiceMetrics.daily_operating_cost: i32` / `dailyOperatingCost`.
- Preserves: `next_vehicle_cost` remains suppressed while the global simulation is paused; nominal daily cost remains based on the route's own `active` state, not the global pause button.
- Preserves: runtime-only service metrics; no save/schema change.

- [ ] **Step 1: Write failing service-output assertions**

In existing zero-fleet Bus service metric coverage, after setting a target that produces `required_fleet`, assert:

```rust
let metrics = engine.snapshot().transit.routes[0]
    .service_metrics
    .expect("output snapshot should publish service metrics");
assert_eq!(metrics.daily_operating_cost, 400 * metrics.required_fleet.unwrap() as i32);
```

In existing deployed Bus coverage assert:

```rust
let snapshot = engine.snapshot();
let metrics = snapshot.transit.routes[0].service_metrics.unwrap();
assert_eq!(
    metrics.daily_operating_cost,
    400 * snapshot.transit.routes[0].vehicle_ids.len() as i32
);
```

Add/extend one Metro output assertion:

```rust
let snapshot = metro_engine.snapshot();
let metrics = snapshot.transit.metro_lines[0].service_metrics.unwrap();
assert_eq!(
    metrics.daily_operating_cost,
    2_500 * snapshot.transit.metro_lines[0].vehicle_ids.len() as i32
);
```

For a deployed Bus paused through `SetRouteActive { active: false }`, assert the output metric is zero:

```rust
assert_eq!(
    engine.snapshot().transit.routes[0]
        .service_metrics
        .unwrap()
        .daily_operating_cost,
    0
);
```

Run the focused tests you edited:

```bash
cargo test -p caelum-core --test service_control daily_operating_cost
```

Expected initially: compile failure because `ServiceMetrics` has no `daily_operating_cost` field.

- [ ] **Step 2: Add the required model field**

In `crates/caelum-core/src/model.rs`:

```rust
pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub estimated_deployment_cost: Option<i32>,
    pub next_vehicle_cost: Option<i32>,
    pub nominal_headway_seconds: Option<f64>,
    pub waiting_at_risk_count: usize,
    pub longest_wait_seconds: Option<f64>,
    pub daily_operating_cost: i32,
}
```

Do not add `#[serde(default)]` or make the field optional.

Run:

```bash
cargo check -p caelum-core
```

Expected: compile failures at every direct `ServiceMetrics` constructor, providing the complete Rust blast radius.

- [ ] **Step 3: Publish cost in the shared Bus/Metro metrics path while preserving pause semantics**

Import the helper in `service_control.rs`:

```rust
use crate::operating_cost::projected_line_daily_operating_cost;
```

Change the private `metrics` signature so route-active state and global-pause state are distinct:

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
) -> Option<ServiceMetrics> {
```

Preserve the existing top-up rule by changing only its first argument:

```rust
let next_vehicle_cost = top_up_offer(
    active && !globally_paused,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Derive the new field after `required_fleet` is known:

```rust
let daily_operating_cost = projected_line_daily_operating_cost(
    active,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Add it to the output literal:

```rust
daily_operating_cost,
```

In `populate_snapshot_metrics`, pass route activity and global pause separately:

```rust
route.service_metrics = metrics(
    route.active,
    snapshot.paused,
    &route.legs,
    TransitMode::Bus,
    &flow,
    route.vehicle_ids.len(),
    route.target_headway_seconds,
    health,
);
```

and the equivalent Metro call.

Update internal `metrics(...)` unit-test calls with the new `globally_paused` argument. Add one assertion that global pause still suppresses `next_vehicle_cost` without zeroing a route-active deployed `daily_operating_cost`.

Run:

```bash
cargo test -p caelum-core service_control::tests
cargo test -p caelum-core --test service_control
```

Expected: PASS after direct literals are fixed.

- [ ] **Step 4: Update the exact wire contract and runtime-only persistence proof**

Use:

```bash
rg "ServiceMetrics \{" crates/caelum-core
rg '"serviceMetrics"' crates/caelum-core/tests/model_wire_format.rs
```

Add `daily_operating_cost` to every direct Rust literal.

In the exact JSON expectation in `crates/caelum-core/tests/model_wire_format.rs`, add:

```json
"dailyOperatingCost": 0
```

for a neutral fixture, or the exact fixture-derived non-zero value when that literal represents an assigned/required fleet.

Do not modify schema version.

Run:

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test service_control
```

Expected: PASS, including the existing proof that save output omits `serviceMetrics`.

- [ ] **Step 5: Commit Task 3**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/service_control.rs crates/caelum-core/tests
git commit -m "feat: publish daily service operating cost"
```

---

### Task 4: Forward the required field through TypeScript without duplicating rules

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/runtime/snapshotView.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/ui/linesPanel.test.ts`

**Interfaces:**
- Consumes: Rust wire `ServiceMetrics.dailyOperatingCost: number`.
- Produces: `ShellServiceState.dailyOperatingCost: number`.
- Rule: TypeScript only forwards the Rust value and uses `0` when `serviceMetrics` is absent; it owns no Bus/Metro constants or formula.

- [ ] **Step 1: Add failing selector expectation before changing types**

In the existing `runtimeSelectors.test.ts` route service fixture that already includes `waitingAtRiskCount` / `longestWaitSeconds`, add Rust input:

```ts
dailyOperatingCost: 1_200,
```

and assert the projected shell service contains:

```ts
expect(route.service.dailyOperatingCost).toBe(1_200);
```

Also keep one route with `serviceMetrics: null` and assert:

```ts
expect(route.service.dailyOperatingCost).toBe(0);
```

Run:

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

Expected initially: TypeScript/test failure because the field is not in the runtime contract.

- [ ] **Step 2: Add required domain/runtime types and selector forwarding**

In `src/domain/types.ts`:

```ts
export interface ServiceMetrics {
  // existing fields
  waitingAtRiskCount: number;
  longestWaitSeconds: number | null;
  dailyOperatingCost: number;
}
```

In `src/runtime/types.ts`:

```ts
export interface ShellServiceState {
  // existing fields
  waitingAtRiskCount: number;
  longestWaitSeconds: number | null;
  dailyOperatingCost: number;
}
```

In `selectServiceState`:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
```

Do not import `EconomyPreset`, `BUS_COST`, `METRO_COST`, or define any operating-cost constant in TypeScript.

Run:

```bash
bun run check
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

Expected: compiler failures now identify remaining non-null service literals; selector test passes once those literals are fixed.

- [ ] **Step 3: Fix only real required-field fallout**

Find current non-null literals:

```bash
rg "longestWaitSeconds:" src tests
```

Add an explicit `dailyOperatingCost` matching each fixture's intended state to:

- `tests/runtime/snapshotView.test.ts`;
- `tests/runtime/gameRuntime.test.ts`;
- `tests/ui/appShell.test.ts`;
- `tests/ui/linesPanel.test.ts`;
- any additional compiler-identified literal.

Use `0` for neutral/broken/no-service fixtures. Use a concrete non-zero quoted value for fixtures whose purpose is to exercise deployed/required service output. Do not make the type optional to avoid this fallout.

Run:

```bash
bun run check
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/snapshotView.test.ts tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/domain/types.ts src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime tests/ui/appShell.test.ts tests/ui/linesPanel.test.ts
git commit -m "feat: project daily operating cost to shell"
```

---

### Task 5: Render one daily-cost row in the existing Lines service blocks

**Files:**
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `tests/ui/linesPanel.test.ts`

**Interfaces:**
- Consumes: `route.service.dailyOperatingCost` from Task 4.
- Uses: existing `formatBudget` only.
- Produces: `Est. daily cost` for zero-fleet targeted service and `Daily cost` for deployed service.

- [ ] **Step 1: Extend the existing pre-deployment Bus test with a failing quoted-cost assertion**

In `shows the pre-deployment bus service block and dispatches target/fleet actions`, set:

```ts
dailyOperatingCost: 1_200,
```

on its `ShellServiceState`, then add:

```ts
expect(service).toHaveTextContent("Est. daily cost");
expect(service).toHaveTextContent("$1,200");
```

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
```

Expected initially: FAIL because the panel does not render the field.

- [ ] **Step 2: Render the pre-deployment estimate only when a required fleet exists**

In the zero-fleet service block, inside the existing `requiredFleet !== null` condition, add:

```svelte
<div class="route-service-row">
  <span class="route-service-label">Est. daily cost</span>
  <span class="route-service-value">
    {formatBudget(route.service.dailyOperatingCost)}
  </span>
</div>
```

Keep it next to `Required` / `Est. deploy cost`; do not add a new component.

Run the test from Step 1.

Expected: PASS.

- [ ] **Step 3: Add failing deployed/paused/Metro display assertions**

Use the nearest existing deployed Bus service-row fixture and set a non-zero value such as:

```ts
dailyOperatingCost: 800,
```

Assert:

```ts
expect(screen.getByTestId("route-service-route-bus-001")).toHaveTextContent(
  "Daily cost",
);
expect(screen.getByTestId("route-service-route-bus-001")).toHaveTextContent(
  "$800",
);
```

Add one paused deployed row whose Rust-owned field is `0` and assert `$0`. Do not calculate zero from `route.active` inside the test/component.

In the existing Metro service fixture, provide `dailyOperatingCost: 5_000` and assert `$5,000` through the same component.

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
```

Expected initially: deployed assertions fail because the row does not exist.

- [ ] **Step 4: Render deployed daily cost unconditionally from the projected value**

In the assigned-fleet service block after Fleet, add:

```svelte
<div class="route-service-row">
  <span class="route-service-label">Daily cost</span>
  <span class="route-service-value">
    {formatBudget(route.service.dailyOperatingCost)}
  </span>
</div>
```

Do not branch on mode, economy preset, active state, broken state, or fleet count in Svelte. Rust already owns the value.

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/components/hud/panels/LinesPanel.svelte tests/ui/linesPanel.test.ts
git commit -m "feat: show daily service cost in lines panel"
```

---

### Task 6: Full regression verification and single-PR handoff

**Files:**
- No new production files expected.
- Modify only files proven necessary by formatting/lint/test failures caused by HPA-645.

**Interfaces:**
- Verifies the complete Rust authority → wire → selector → Lines row path plus existing HPA-628/HPA-643 behavior.

- [ ] **Step 1: Prove no duplicate cost formula or forbidden economy machinery was introduced**

Run:

```bash
rg "400|2_500|2500" src tests crates/caelum-core/src \
  -g '!crates/caelum-core/src/operating_cost.rs' \
  -g '!**/*test*' \
  -g '!docs/**'
rg "lastChargedDay|RecurringExpense|ledger|subsid|fare" crates/caelum-core/src src
```

Expected:

- no production TypeScript/Rust copy of the HPA-645 daily constants outside `operating_cost.rs`;
- no new persisted charge marker, ledger, fare, or subsidy machinery.

Existing unrelated words may appear; inspect them rather than deleting unrelated code.

- [ ] **Step 2: Run focused Rust verification**

```bash
cargo fmt --all -- --check
cargo test -p caelum-core operating_cost::tests
cargo test -p caelum-core --test service_control
cargo test -p caelum-core --test model_wire_format
```

Expected: PASS.

- [ ] **Step 3: Run focused frontend verification**

```bash
bun run check
bun run test:unit -- \
  tests/runtime/runtimeSelectors.test.ts \
  tests/runtime/snapshotView.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/appShell.test.ts \
  tests/ui/linesPanel.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run repository-wide gates**

```bash
bun run format:check
bun run lint
bun run rust:test
bun run test:unit
```

Expected: PASS.

No new Playwright test is required for this slice. If an existing e2e route test fails because the required wire field changed, fix that fixture/expectation and rerun only the affected spec; do not add a midnight-waiting e2e scenario.

- [ ] **Step 5: Review the diff against the design scope**

Run:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- \
  crates/caelum-core/src/operating_cost.rs \
  crates/caelum-core/src/trips.rs \
  crates/caelum-core/src/service_control.rs \
  src/components/hud/panels/LinesPanel.svelte
```

Confirm:

- exactly one focused operating-cost module exists;
- no schema version changed;
- paid capital-intent authorization code is untouched except imports required by compilation;
- no revenue/accounting/history subsystem appeared;
- this branch still represents the single HPA-645 PR.

- [ ] **Step 6: Commit any verification-only fixes**

If verification required HPA-645-specific formatting or fixture fixes:

```bash
git add <only HPA-645 files>
git commit -m "test: complete daily operating cost coverage"
```

If no fixes were needed, do not create an empty commit.

## Implementation completion criteria

HPA-645 is ready to move out of draft when all of the following are true:

1. Standard one-Bus fixture charges `$400` at the day boundary and can move `399 -> -1` without ending Sandbox.
2. Creative runs the same day boundary with unchanged budget while publishing the same nominal service cost.
3. Coarse and split ticks agree on time/day/budget.
4. A restored already-charged boundary does not charge again before the next day.
5. Zero-fleet target projection shows required fleet × daily mode cost before deployment.
6. Deployed active/connected service shows assigned fleet × daily mode cost; paused/broken service is zero/not charged.
7. Bus and Metro share the same Rust projection path with 400 / 2,500 unit values.
8. `ServiceMetrics.dailyOperatingCost` is required output, camelCase on the wire, ignored on restore, and absent from save output.
9. TypeScript forwards the value only; Svelte formats/renders it only.
10. Existing HPA-628 top-up and HPA-643 route-health tests remain green.
11. No fares, subsidy, proration, ledger/history, finance screen, schema bump, or second PR was introduced.