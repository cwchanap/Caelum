# HPA-645 Daily Vehicle Operating Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish separate actual and pre-deployment daily Bus/Metro operating costs, deduct only the actual deployed cost once per game day in Standard, keep Creative budget-neutral, and expose the current city-wide daily burn.

**Architecture:** Add one focused Rust `operating_cost` module containing the only deployed-line cost rule, the pre-deployment estimator, city aggregation, and the midnight debit. Reuse the existing `trips` day-boundary substep. Extend runtime-only `ServiceMetrics` with separate actual/estimated fields, preserve the HPA-628 global-pause behavior by splitting route activity from global pause, then forward values through TypeScript to Lines and one Topbar aggregate.

**Tech Stack:** Rust `caelum-core`, serde wire contracts, TypeScript runtime selectors, Svelte 5, Vitest/Testing Library, existing Rust integration tests.

**Spec:** `docs/superpowers/specs/2026-08-19-daily-vehicle-operating-cost-design.md`

## Global Constraints

- Bus daily operating cost is exactly `400`; Metro is exactly `2_500`.
- The recurring constants are independent from `BUS_COST` / `METRO_COST`; never derive one from the other.
- `line_daily_operating_cost` is the only deployed-line liability rule consumed by both billing and service projection.
- Actual cost requires assigned fleet, an active operational non-empty route, and present `current_path` on every leg; otherwise it is zero.
- `dailyOperatingCost` means actual current deployed liability only and is always summable.
- `estimatedDailyOperatingCost` means hypothetical pre-deployment required-fleet cost only and is nullable.
- Global simulation pause does not zero actual nominal liability; route pause does.
- HPA-628 `nextVehicleCost` remains suppressed while globally paused.
- Standard debits exactly once per observed midnight and may cross below zero.
- Creative publishes the same nominal costs but does not debit budget.
- Do not use `CostPolicy::quote`, `authorize`, or `apply_to` for recurring debit.
- Do not couple `operating_cost` to `CostPolicy` only for preset mapping; match the persisted `EconomyPreset` directly.
- Add no Campaign-specific branch or Campaign regression; Campaign/growth is scheduled for deletion.
- Add no `crossed_days`, `lastChargedDay`, scheduler, ledger, proration, refund, transaction history, or schema field.
- `ServiceMetrics` remains runtime output only; no schema bump.
- TypeScript may sum Rust-published `dailyOperatingCost` fields for presentation, but must not contain mode costs, fleet multiplication, chargeability predicates, or preset logic.
- Add one Topbar `Daily cost` readout; no finance panel/chart/history.
- HPA-646 is the required next HPA-335 slice for positive transit income; do not implement HPA-646 in this PR.
- One ticket, one PR: continue implementation on draft PR #50; do not open a second implementation PR.

---

## Baseline gate

Before implementation, update the planning branch and prove the existing service/tick seams are green:

```bash
git fetch origin
git rebase origin/main

rg "pub struct ServiceMetrics" crates/caelum-core/src/model.rs
rg "fn metrics\(|populate_snapshot_metrics" crates/caelum-core/src/service_control.rs
rg "fn advance_tick_substep|next_boundary_after" crates/caelum-core/src/trips.rs
rg "pub(crate) enum CostPolicy|fn from_snapshot" crates/caelum-core/src/cost_policy.rs
rg "ShellTopbarState|ShellServiceState" src/runtime/types.ts
rg "function selectServiceState|topbar:" src/runtime/runtimeSelectors.ts
```

Run:

```bash
cargo test -p caelum-core --test service_control
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
```

Expected: PASS before HPA-645 production edits.

---

## File map

### Rust production

- Create `crates/caelum-core/src/operating_cost.rs` — constants, actual line rule, estimator, city sum, midnight debit.
- Modify `crates/caelum-core/src/lib.rs` — register `operating_cost` as `pub(crate)`.
- Modify `crates/caelum-core/src/trips.rs` — invoke midnight debit immediately after `sync_clock` in `advance_tick_substep`.
- Modify `crates/caelum-core/src/model.rs` — add required runtime-only `daily_operating_cost` and `estimated_daily_operating_cost` to `ServiceMetrics`.
- Modify `crates/caelum-core/src/service_control.rs` — publish both fields; split `route_active` from `globally_paused`.

### Rust tests

- Unit tests in `crates/caelum-core/src/operating_cost.rs`.
- Modify `crates/caelum-core/tests/service_control.rs` — public tick/debit, Creative parity, pause/broken, coarse/fine, save/restore, output semantics.
- Modify `crates/caelum-core/tests/model_wire_format.rs` — exact camelCase fields.
- Update any direct `ServiceMetrics { ... }` literals found by `rg "ServiceMetrics \\{" crates/caelum-core`.

### TypeScript / Svelte

- Modify `src/domain/types.ts` — two required ServiceMetrics keys.
- Modify `src/runtime/types.ts` — two ShellServiceState keys + `ShellTopbarState.dailyOperatingCost`.
- Modify `src/runtime/runtimeSelectors.ts` — forward per-line values and sum actual deployed liability for Topbar.
- Modify `src/components/hud/panels/LinesPanel.svelte` — estimate row vs actual row.
- Modify `src/components/Topbar.svelte` — add one `Daily cost` readout.

### TypeScript tests

- Modify `tests/runtime/runtimeSelectors.test.ts`.
- Modify `tests/runtime/snapshotView.test.ts` only for required non-null `ServiceMetrics` literals.
- Modify `tests/runtime/gameRuntime.test.ts` only for required non-null `ServiceMetrics` literals.
- Modify `tests/ui/appShell.test.ts` — Topbar readout + fixture fallout.
- Modify `tests/ui/linesPanel.test.ts` — estimate/actual rendering + fixture fallout.

No Playwright midnight scenario.

---

### Task 1: Add the single Rust operating-cost authority

**Files:**
- Create: `crates/caelum-core/src/operating_cost.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**

```rust
pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;

pub(crate) fn vehicle_daily_operating_cost(mode: TransitMode) -> i32;
pub(crate) fn fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32;
pub(crate) fn line_daily_operating_cost(
    route_active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
) -> i32;
pub(crate) fn estimated_line_daily_operating_cost(
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32>;
pub(crate) fn city_daily_operating_cost(state: &GameSnapshot) -> i32;
pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32);
```

- [ ] **Step 1: Add failing unit tests for actual and estimated semantics**

Create `operating_cost.rs` with the imports, constants, and `#[cfg(test)]` module first. Add a local connected-leg fixture:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        EconomyPreset, RouteLegKind, RouteLegStatus, ServiceDirection, TransitPath,
    };

    fn connected_leg() -> RouteLegPath {
        RouteLegPath {
            from_waypoint_id: "a".into(),
            to_waypoint_id: "b".into(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: Some(TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            }),
            last_valid_path: None,
            estimated_seconds: Some(1.0),
            failure_reason: None,
        }
    }

    #[test]
    fn actual_line_cost_is_only_for_assigned_operational_service() {
        let legs = vec![connected_leg()];
        assert_eq!(line_daily_operating_cost(true, &legs, TransitMode::Bus, 2), 800);
        assert_eq!(line_daily_operating_cost(false, &legs, TransitMode::Bus, 2), 0);
        assert_eq!(line_daily_operating_cost(true, &[], TransitMode::Bus, 2), 0);
        assert_eq!(line_daily_operating_cost(true, &legs, TransitMode::Bus, 0), 0);

        let mut missing_path = connected_leg();
        missing_path.current_path = None;
        assert_eq!(
            line_daily_operating_cost(true, &[missing_path], TransitMode::Bus, 2),
            0,
        );

        let mut broken = connected_leg();
        broken.status = RouteLegStatus::NetworkDisconnected;
        assert_eq!(
            line_daily_operating_cost(true, &[broken], TransitMode::Bus, 2),
            0,
        );
    }

    #[test]
    fn estimated_cost_exists_only_before_fleet_assignment() {
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 0, Some(3)),
            Some(1_200),
        );
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 0, None),
            None,
        );
        assert_eq!(
            estimated_line_daily_operating_cost(TransitMode::Bus, 1, Some(3)),
            None,
        );
    }
}
```

Run:

```bash
cargo test -p caelum-core operating_cost::tests
```

Expected: compile failures because the functions do not exist yet.

- [ ] **Step 2: Implement constants and fleet multiplication**

Add:

```rust
use crate::model::{EconomyPreset, GameSnapshot, RouteLegPath, TransitMode};
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

Add a test:

```rust
#[test]
fn mode_costs_and_fleet_multiplication_are_explicit() {
    assert_eq!(vehicle_daily_operating_cost(TransitMode::Bus), 400);
    assert_eq!(vehicle_daily_operating_cost(TransitMode::Metro), 2_500);
    assert_eq!(vehicle_daily_operating_cost(TransitMode::Walk), 0);
    assert_eq!(fleet_daily_operating_cost(TransitMode::Metro, 3), 7_500);
    assert_eq!(fleet_daily_operating_cost(TransitMode::Metro, usize::MAX), i32::MAX);
}
```

- [ ] **Step 3: Implement the one actual-line rule and pre-deployment estimator**

Add:

```rust
pub(crate) fn line_daily_operating_cost(
    route_active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
) -> i32 {
    if assigned_fleet == 0
        || legs.is_empty()
        || !is_route_operational(route_active, legs)
        || legs.iter().any(|leg| leg.current_path.is_none())
    {
        return 0;
    }
    fleet_daily_operating_cost(mode, assigned_fleet)
}

pub(crate) fn estimated_line_daily_operating_cost(
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32> {
    if assigned_fleet > 0 {
        return None;
    }
    required_fleet.map(|required| fleet_daily_operating_cost(mode, required))
}
```

Run:

```bash
cargo test -p caelum-core operating_cost::tests
```

Expected: the first two behavior tests pass; city/debit functions are not added yet.

- [ ] **Step 4: Add the city sum and midnight debit using the same line rule**

Add:

```rust
pub(crate) fn city_daily_operating_cost(state: &GameSnapshot) -> i32 {
    let bus = state.transit.routes.iter().fold(0_i32, |total, route| {
        total.saturating_add(line_daily_operating_cost(
            route.active,
            &route.legs,
            TransitMode::Bus,
            route.vehicle_ids.len(),
        ))
    });

    state.transit.metro_lines.iter().fold(bus, |total, line| {
        total.saturating_add(line_daily_operating_cost(
            line.active,
            &line.legs,
            TransitMode::Metro,
            line.vehicle_ids.len(),
        ))
    })
}

pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32) {
    if state.day <= previous_day || state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }
    let total = city_daily_operating_cost(state);
    if total > 0 {
        state.budget = state.budget.saturating_sub(total);
    }
}
```

Do not add `GameMode`, `CostPolicy`, `crossed_days`, or `lastChargedDay` imports/state.

- [ ] **Step 5: Lock debit and city aggregation**

Add:

```rust
#[test]
fn standard_debit_can_cross_below_zero_but_creative_does_not_pay() {
    let mut state = crate::state::create_initial_snapshot();
    state.transit.routes.clear();
    state.transit.metro_lines.clear();
    state.budget = 399;
    state.day = 1;

    // Build the route with existing model helpers in this test module so it has
    // one vehicle ID and one connected/current-path leg.
    state.transit.routes.push(test_bus_route(vec![connected_leg()], 1));

    apply_day_boundary_charge(&mut state, 0);
    assert_eq!(state.budget, -1);

    state.budget = 399;
    state.rules.economy_preset = EconomyPreset::Creative;
    apply_day_boundary_charge(&mut state, 0);
    assert_eq!(state.budget, 399);
}
```

Implement `test_bus_route(legs, fleet)` in the test module by cloning the route fixture already used by nearby service-control tests if moving a helper is simpler; do not add a production fixture API.

Also assert a Bus + Metro state sums the two actual costs and excludes zero-fleet lines.

- [ ] **Step 6: Register the module and run focused Rust checks**

In `lib.rs`:

```rust
pub(crate) mod operating_cost;
```

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core operating_cost::tests
cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add crates/caelum-core/src/operating_cost.rs crates/caelum-core/src/lib.rs
git commit -m "feat: add daily vehicle operating cost authority"
```

---

### Task 2: Attach Standard settlement to the existing midnight substep

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify/Test: `crates/caelum-core/tests/service_control.rs`

**Consumes:** `operating_cost::apply_day_boundary_charge`.

- [ ] **Step 1: Add a public-engine Standard regression**

In `tests/service_control.rs`, add a small helper that deploys exactly one Bus using the existing `bus_route_engine()` fixture:

```rust
fn one_bus_service_engine() -> GameEngine {
    let mut engine = bus_route_engine();
    assert!(engine
        .dispatch(GameIntent::SetServiceTargetHeadway {
            line_id: "route-001".into(),
            target_headway_seconds: 3_600,
        })
        .applied);
    assert!(engine
        .dispatch(GameIntent::DeployInitialFleet {
            line_id: "route-001".into(),
        })
        .applied);
    assert_eq!(engine.snapshot().transit.routes[0].vehicle_ids.len(), 1);
    engine
}
```

Then add:

```rust
#[test]
fn standard_daily_operating_cost_crosses_budget_below_zero_at_midnight() {
    let mut engine = one_bus_service_engine();
    engine.set_budget_for_test(399);
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let result = engine.tick(caelum_core::clock::GAME_DAY_SECONDS);

    assert!(result.applied);
    assert_eq!(result.snapshot.day, 1);
    assert_eq!(result.snapshot.budget, -1);
    assert_eq!(result.snapshot.metrics.state, caelum_core::model::MetricsState::Running);
}
```

Run:

```bash
cargo test -p caelum-core --test service_control standard_daily_operating_cost_crosses_budget_below_zero_at_midnight
```

Expected initially: FAIL with budget still `399`.

- [ ] **Step 2: Hook the debit after `sync_clock`**

In `advance_tick_substep` change the beginning to:

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

Do not call the debit from `on_substep`.

Re-run the Standard test; expected PASS.

- [ ] **Step 3: Lock Creative budget neutrality and nominal parity placeholder**

Add a Creative engine by taking the deployed snapshot and restoring it with Creative rules:

```rust
fn creative_one_bus_service_engine() -> GameEngine {
    let deployed = one_bus_service_engine();
    let mut snapshot = deployed.snapshot_for_save();
    snapshot.rules.economy_preset = EconomyPreset::Creative;
    snapshot.budget = 399;
    GameEngine::from_snapshot(snapshot).unwrap()
}

#[test]
fn creative_keeps_budget_across_midnight() {
    let mut engine = creative_one_bus_service_engine();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let result = engine.tick(caelum_core::clock::GAME_DAY_SECONDS);
    assert_eq!(result.snapshot.budget, 399);
}
```

The nominal `dailyOperatingCost == 400` assertion is added in Task 3 after the field exists; keep this test and extend it there.

- [ ] **Step 4: Lock coarse-vs-split boundary determinism**

Add:

```rust
#[test]
fn daily_charge_is_identical_for_coarse_and_split_ticks() {
    let mut coarse = one_bus_service_engine();
    let mut split = one_bus_service_engine();
    coarse.set_budget_for_test(5_000);
    split.set_budget_for_test(5_000);
    assert!(coarse.dispatch(GameIntent::SetPaused { paused: false }).applied);
    assert!(split.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let coarse_result = coarse.tick(caelum_core::clock::GAME_DAY_SECONDS + 60.0);
    let _ = split.tick(caelum_core::clock::GAME_DAY_SECONDS - 10.0);
    let split_result = split.tick(70.0);

    assert_eq!(coarse_result.snapshot.time, split_result.snapshot.time);
    assert_eq!(coarse_result.snapshot.day, split_result.snapshot.day);
    assert_eq!(coarse_result.snapshot.budget, split_result.snapshot.budget);
}
```

Expected: PASS only when settlement is tied to the existing midnight boundary.

- [ ] **Step 5: Lock save/restore no-double-charge**

Add:

```rust
#[test]
fn restored_post_midnight_snapshot_does_not_charge_again_same_day() {
    let mut engine = one_bus_service_engine();
    engine.set_budget_for_test(1_000);
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let midnight = engine.tick(caelum_core::clock::GAME_DAY_SECONDS);
    assert_eq!(midnight.snapshot.budget, 600);

    let saved = engine.snapshot_for_save();
    let mut restored = GameEngine::from_snapshot(saved).unwrap();
    assert!(restored.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let later = restored.tick(10.0);

    assert_eq!(later.snapshot.day, 1);
    assert_eq!(later.snapshot.budget, 600);
}
```

- [ ] **Step 6: Lock route pause and broken service billing**

Use `one_bus_service_engine()` for route pause:

```rust
let mut paused_route = one_bus_service_engine();
paused_route.set_budget_for_test(1_000);
assert!(paused_route.dispatch(GameIntent::SetRouteActive {
    route_id: "route-001".into(),
    active: false,
}).applied);
assert!(paused_route.dispatch(GameIntent::SetPaused { paused: false }).applied);
let result = paused_route.tick(caelum_core::clock::GAME_DAY_SECONDS);
assert_eq!(result.snapshot.budget, 1_000);
```

For broken service, reuse the existing road-removal fixture/path in this file after deployment; break one live route leg, cross midnight, and assert budget unchanged. Do not create a second topology harness.

- [ ] **Step 7: Run Task 2 regression gate and commit**

```bash
cargo fmt --all --check
cargo test -p caelum-core --test service_control
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/trips.rs crates/caelum-core/tests/service_control.rs
git commit -m "feat: charge operating cost at game-day boundary"
```

---

### Task 3: Split actual/estimated ServiceMetrics and preserve global-pause semantics

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`
- Modify any direct Rust `ServiceMetrics` literals found by scan.

**Produces:**

```rust
ServiceMetrics {
    // existing fields...
    daily_operating_cost: i32,
    estimated_daily_operating_cost: Option<i32>,
}
```

- [ ] **Step 1: Add the required model fields**

In `ServiceMetrics`:

```rust
pub daily_operating_cost: i32,
pub estimated_daily_operating_cost: Option<i32>,
```

Do not add serde defaults to the fields.

Run:

```bash
cargo check -p caelum-core
```

Expected: compile failures at every direct `ServiceMetrics` constructor, which identifies the intentional blast radius.

- [ ] **Step 2: Split the `metrics` booleans and publish both cost fields**

Change the signature to:

```rust
fn metrics(
    route_active: bool,
    globally_paused: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
    assigned_fleet: usize,
    target_headway_seconds: Option<u32>,
    waiting_health: WaitingHealth,
) -> Option<ServiceMetrics> {
```

After `required_fleet` is derived, add:

```rust
let daily_operating_cost = crate::operating_cost::line_daily_operating_cost(
    route_active,
    legs,
    mode,
    assigned_fleet,
);
let estimated_daily_operating_cost =
    crate::operating_cost::estimated_line_daily_operating_cost(
        mode,
        assigned_fleet,
        required_fleet,
    );
```

Keep top-up separate:

```rust
let next_vehicle_cost = top_up_offer(
    route_active && !globally_paused,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

Populate the two fields in `ServiceMetrics`.

- [ ] **Step 3: Make call-site semantics readable**

Before each Bus/Metro `metrics` call in `populate_snapshot_metrics`, bind:

```rust
let route_active = route.active;
let globally_paused = snapshot.paused;
```

and pass them as the first two arguments. Use equivalent `line_active` local for Metro if that reads more naturally, but the `metrics` parameter remains named `route_active` as the mode-neutral service flag.

Do not pass `route.active && !snapshot.paused` as one folded value.

- [ ] **Step 4: Lock actual-vs-estimated output semantics**

Extend existing service-control integration tests:

```rust
let setup = engine.snapshot().transit.routes[0]
    .service_metrics
    .as_ref()
    .unwrap();
assert_eq!(setup.daily_operating_cost, 0);
assert_eq!(setup.estimated_daily_operating_cost, Some(400));
```

for a one-required-Bus zero-fleet target.

After deployment:

```rust
let deployed = engine.snapshot().transit.routes[0]
    .service_metrics
    .as_ref()
    .unwrap();
assert_eq!(deployed.daily_operating_cost, 400);
assert_eq!(deployed.estimated_daily_operating_cost, None);
```

Add one Metro assertion with one train:

```rust
assert_eq!(metrics.daily_operating_cost, 2_500);
assert_eq!(metrics.estimated_daily_operating_cost, None);
```

- [ ] **Step 5: Lock the global-pause split**

On a deployed active one-Bus service:

```rust
assert!(engine.dispatch(GameIntent::SetPaused { paused: true }).applied);
let paused = engine.snapshot();
let metrics = paused.transit.routes[0].service_metrics.as_ref().unwrap();
assert_eq!(metrics.daily_operating_cost, 400);
```

On the existing HPA-628 shortfall fixture, globally pause and assert:

```rust
assert_eq!(metrics.next_vehicle_cost, None);
```

This is the regression against re-folding the booleans later.

- [ ] **Step 6: Complete the Creative nominal-parity assertion**

Extend Task 2's Creative test after midnight:

```rust
let metrics = result.snapshot.transit.routes[0]
    .service_metrics
    .as_ref()
    .unwrap();
assert_eq!(result.snapshot.budget, 399);
assert_eq!(metrics.daily_operating_cost, 400);
```

- [ ] **Step 7: Update the exact wire contract**

In `model_wire_format.rs`, every neutral `serviceMetrics` JSON object gains:

```json
"dailyOperatingCost": 0,
"estimatedDailyOperatingCost": null
```

For a targeted zero-fleet fixture, use the actual expected estimate rather than weakening the assertion.

Update all direct Rust `ServiceMetrics { ... }` literals found by:

```bash
rg "ServiceMetrics \\{" crates/caelum-core
```

Do not add defaults/aliases to avoid these edits.

- [ ] **Step 8: Prove service metrics remain output-only**

Retain/extend existing assertions that:

- forged incoming route/Metro `serviceMetrics` is ignored;
- `snapshot_for_save()` omits `serviceMetrics` entirely.

No schema version change.

- [ ] **Step 9: Run Task 3 gate and commit**

```bash
cargo fmt --all --check
cargo test -p caelum-core --test service_control
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/model.rs crates/caelum-core/src/service_control.rs crates/caelum-core/tests
git commit -m "feat: publish actual and estimated daily service cost"
```

---

### Task 4: Forward costs to Lines and expose current city daily burn

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Modify: `src/components/Topbar.svelte`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify required-field fixture literals in `tests/runtime/snapshotView.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/ui/appShell.test.ts`, `tests/ui/linesPanel.test.ts`.

- [ ] **Step 1: Extend TypeScript contracts without optional escape hatches**

In `ServiceMetrics`:

```ts
dailyOperatingCost: number;
estimatedDailyOperatingCost: number | null;
```

In `ShellServiceState`:

```ts
dailyOperatingCost: number;
estimatedDailyOperatingCost: number | null;
```

In `ShellTopbarState`:

```ts
dailyOperatingCost: string;
```

Run:

```bash
bun run check
```

Expected initially: fixture/selector construction errors.

- [ ] **Step 2: Forward both per-line fields**

In `selectServiceState`:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
estimatedDailyOperatingCost:
  route.serviceMetrics?.estimatedDailyOperatingCost ?? null,
```

No mode/preset/route-status branch.

- [ ] **Step 3: Add only presentation aggregation for Topbar**

Before constructing `ShellTopbarState` in `selectShellState`, compute:

```ts
const dailyOperatingCost = [
  ...state.transit.routes,
  ...state.transit.metroLines,
].reduce(
  (total, line) => total + (line.serviceMetrics?.dailyOperatingCost ?? 0),
  0,
);
```

Then:

```ts
topbar: {
  budget: formatBudget(state.budget),
  dailyOperatingCost: formatBudget(dailyOperatingCost),
  // existing fields unchanged
}
```

This sum must never read `estimatedDailyOperatingCost`.

- [ ] **Step 4: Add a selector regression that excludes hypothetical estimates**

In `runtimeSelectors.test.ts`, construct:

- one deployed Bus `dailyOperatingCost: 400`, estimate `null`;
- one deployed Metro `dailyOperatingCost: 2_500`, estimate `null`;
- one zero-fleet Bus `dailyOperatingCost: 0`, `estimatedDailyOperatingCost: 1_200`.

Assert:

```ts
expect(shell.topbar.dailyOperatingCost).toBe("$2,900");
expect(shell.routes.find((route) => route.id === "setup")?.service)
  .toMatchObject({
    dailyOperatingCost: 0,
    estimatedDailyOperatingCost: 1_200,
  });
```

The `$1,200` hypothetical must not appear in the Topbar total.

- [ ] **Step 5: Render separate Lines fields with no semantic overloading**

In the zero-fleet service block, near `Est. deploy cost`:

```svelte
{#if route.service.estimatedDailyOperatingCost !== null}
  <div class="route-service-row">
    <span class="route-service-label">Est. daily cost</span>
    <span class="route-service-value">
      {formatBudget(route.service.estimatedDailyOperatingCost)}
    </span>
  </div>
{/if}
```

In the deployed block:

```svelte
<div class="route-service-row">
  <span class="route-service-label">Daily cost</span>
  <span class="route-service-value">
    {formatBudget(route.service.dailyOperatingCost)}
  </span>
</div>
```

Do not gate the deployed row on target/required fleet; `dailyOperatingCost` already has exact Rust semantics.

- [ ] **Step 6: Add the Topbar readout**

Add to `readouts`:

```ts
{ key: "dailyOperatingCost", label: "Daily cost" },
```

Do not add a new component or finance panel.

- [ ] **Step 7: Lock Lines rendering**

In `linesPanel.test.ts`:

For the existing zero-fleet setup fixture add:

```ts
dailyOperatingCost: 0,
estimatedDailyOperatingCost: 1_200,
```

and assert:

```ts
expect(service).toHaveTextContent("Est. daily cost");
expect(service).toHaveTextContent("$1,200");
expect(service).not.toHaveTextContent("Daily cost $0");
```

For a deployed Bus:

```ts
dailyOperatingCost: 800,
estimatedDailyOperatingCost: null,
```

assert `Daily cost` + `$800` and no `Est. daily cost`.

For route-paused/broken fixture, supply Rust-projected `dailyOperatingCost: 0` and assert `$0`; Svelte must not recalculate why.

- [ ] **Step 8: Lock the Topbar readout in AppShell**

Update the shell fixture to contain:

```ts
dailyOperatingCost: "$2,900",
```

and assert the rendered Topbar contains label `Daily cost` and value `$2,900`.

- [ ] **Step 9: Update required-field fixture fallout**

For every non-null `ServiceMetrics` / `ShellServiceState` literal in the named test files, add semantically neutral values:

```ts
dailyOperatingCost: 0,
estimatedDailyOperatingCost: null,
```

unless the test is specifically about HPA-645, in which case use meaningful values.

Do not edit helpers whose relevant service metrics are `null` solely for this field addition.

- [ ] **Step 10: Prove there is no frontend cost formula**

Run:

```bash
rg "400|2_500|2500|BUS_DAILY|METRO_DAILY" src tests --glob '!docs/**'
```

Expected: no production `src/` match for HPA-645 constants. Numeric matches in unrelated tests must be inspected rather than blindly deleted.

Also run:

```bash
rg "vehicleIds\.length.*daily|requiredFleet.*daily|economyPreset.*daily" src
```

Expected: no HPA-645 formula/preset branch.

- [ ] **Step 11: Run Task 4 gate and commit**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/snapshotView.test.ts tests/runtime/gameRuntime.test.ts tests/ui/linesPanel.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
bun run format:check

git add src tests
git commit -m "feat: show service and city daily operating cost"
```

---

### Task 5: Whole-slice verification and scope audit

**Files:** no new production files expected.

- [ ] **Step 1: Run all Rust gates**

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 2: Run all frontend/browser gates**

```bash
bun run test:unit
bun run check
bun run lint:svelte
bun run lint:css
bun run format:check
bun run test:e2e
bun run build
```

Expected: PASS. No HPA-645-specific Playwright midnight test is added.

- [ ] **Step 3: Audit the architecture boundaries**

Run:

```bash
rg "crossed_days|lastChargedDay|last_charged_day|RecurringExpense|ledger|transaction history" crates src
rg "GameMode::Campaign|GameMode::Sandbox" crates/caelum-core/src/operating_cost.rs
rg "CostPolicy" crates/caelum-core/src/operating_cost.rs
rg "400|2_500|2500|BUS_DAILY|METRO_DAILY" src
rg "dailyOperatingCost|estimatedDailyOperatingCost" src tests crates/caelum-core
```

Expected:

- no catch-up settlement/history/ledger abstraction;
- no Campaign preservation branch in `operating_cost.rs`;
- no `CostPolicy` dependency in `operating_cost.rs`;
- no production TypeScript operating-cost constants;
- two distinct service-metric fields flow Rust → TS → UI;
- Topbar aggregation reads only actual `dailyOperatingCost`.

- [ ] **Step 4: Verify schema/persistence scope**

Run:

```bash
git diff origin/main...HEAD -- crates/caelum-core/src/model.rs crates/caelum-core/src/persistence src/persistence src-tauri
```

Expected:

- `ServiceMetrics` gains the two runtime-only fields;
- no persistence module needs a new canonical field;
- `SNAPSHOT_SCHEMA_VERSION` is unchanged;
- no migration or compatibility code is added.

- [ ] **Step 5: Verify the single-PR scope**

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected production shape:

- one new Rust `operating_cost.rs` module;
- one tick hook in `trips.rs`;
- two runtime-only ServiceMetrics fields;
- one shared `line_daily_operating_cost` rule used by billing and projection;
- thin TS forwarding + actual-only Topbar sum;
- one Lines estimate row, one Lines actual row, one Topbar readout;
- no second PR, scheduler, ledger, fares, revenue implementation, schema bump, Campaign preservation, or generic economy framework.

- [ ] **Step 6: Update PR #50 implementation evidence without creating another PR**

Append the actual verification results to PR #50's body and change its planning-only wording to implementation-complete only after all gates pass.

Keep Linear HPA-645 In Progress until the implementation is reviewed/merged. HPA-646 stays Backlog as the next required HPA-335 slice.

No commit is needed for PR/Linear metadata-only updates.