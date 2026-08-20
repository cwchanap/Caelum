# HPA-646 Minimal Transit Income Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit Standard sandbox `$200` exactly once for each completed journey that used Bus or Metro, giving useful transit a direct recovery path from negative budget while Creative remains budget-neutral.

**Architecture:** Add one focused Rust `transit_income` module that classifies a resolved `ActiveTrip` and applies preset-aware positive budget settlement. Reuse the existing `trips::advance_active_trips_with_zero_delta_ids` resolution pass to aggregate income before terminal trips are removed. Do not add a scheduler, daily accumulator, line attribution, wire field, frontend formula, or persistence field.

**Tech Stack:** Rust `caelum-core`, existing trip/route-plan model, existing Rust unit/integration-style module tests. No TypeScript/Svelte production change.

**Spec:** `docs/superpowers/specs/2026-08-20-minimal-transit-income-design.md`

## Global Constraints

- `TRANSIT_TRIP_INCOME` is exactly `200`.
- A completed journey earns once when terminal status is `Arrived` or `Late` and its retained `RoutePlan` contains at least one Bus or Metro leg.
- Bus → Metro or other multi-leg transfers still earn exactly `$200` once per journey, not once per boarding/line/mode.
- Walk-only, private-car/planless, unserved, and non-terminal trips earn zero.
- Standard applies positive income immediately at trip resolution and may recover from a negative budget.
- Creative never mutates budget for transit income.
- Use saturating integer addition for income aggregation and budget settlement.
- Do not use `CostPolicy`; it exists for capital-purchase deductions.
- Reuse the existing trip-resolution boundary. Add no scheduler, midnight income settlement, new `next_boundary_after` source, daily accumulator, or settlement marker.
- Do not add Campaign-specific behavior or tests; Campaign/growth is scheduled for deletion.
- Do not add `ServiceMetrics`, `Metrics`, TypeScript, Svelte, or persistence fields for revenue/profit.
- Snapshot schema remains version 9; no migration or compatibility work.
- Keep `operating_cost.rs` and the new transit-income rule separate; do not create a generic economy manager/trait/ledger.
- One ticket, one PR: implement on the HPA-646 draft PR branch only; do not open a second PR.

---

## Baseline gate

Before production edits, update the implementation checkout to the planning branch and confirm the seams named by the design still exist:

```bash
git fetch origin
git checkout jack65786656/hpa-646-phase-5-add-minimal-transit-income-to-prevent-standard
git rebase origin/main

rg "fn advance_active_trips_with_zero_delta_ids|fn score_arrival" crates/caelum-core/src/trips.rs
rg "pub struct ActiveTrip|pub struct RoutePlan|pub struct RouteLeg" crates/caelum-core/src/model.rs
rg "apply_day_boundary_charge|BUS_DAILY_OPERATING_COST|METRO_DAILY_OPERATING_COST" crates/caelum-core/src/operating_cost.rs
rg "budget: formatBudget\(state.budget\)" src/runtime/runtimeSelectors.ts
```

Run the focused pre-change Rust tests:

```bash
cargo test -p caelum-core trips::tests
cargo test -p caelum-core operating_cost::tests
```

Expected: PASS before HPA-646 production edits.

---

## File map

### Rust production

- Create `crates/caelum-core/src/transit_income.rs` — fixed journey-income constant, qualification rule, and Standard/Creative budget settlement.
- Modify `crates/caelum-core/src/lib.rs` — register `transit_income` as `pub(crate)`.
- Modify `crates/caelum-core/src/trips.rs` — aggregate income from resolved trip results and apply it once before terminal results are consumed.

### Rust tests

- Add unit tests beside production code in `crates/caelum-core/src/transit_income.rs` — exact qualification and settlement semantics.
- Add focused wiring regressions in the existing `#[cfg(test)]` module in `crates/caelum-core/src/trips.rs` — one-shot credit, Creative, walking-only, and multi-trip aggregation.

### Explicitly unchanged

- `crates/caelum-core/src/model.rs` — no model/wire/schema field.
- `crates/caelum-core/src/operating_cost.rs` — HPA-645 cost behavior stays independent.
- `src/**` and `tests/**` TypeScript/Svelte — existing budget projection already makes Rust income visible; no new UI contract.
- persistence adapters/normalization — budget already persists.

---

### Task 1: Add the single transit-income authority

**Files:**
- Create: `crates/caelum-core/src/transit_income.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Consumes: `model::ActiveTrip`, `EconomyPreset`, `GameSnapshot`, `TransitMode`, `TripStatus`.
- Produces:

```rust
pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32;

pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32);
```

- [ ] **Step 1: Create `transit_income.rs` with failing qualification tests**

Start the file with imports, the constant, and the test fixture. Do not add production function bodies yet.

```rust
use crate::model::{ActiveTrip, EconomyPreset, GameSnapshot, TransitMode, TripStatus};

pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Point, RouteLeg, RoutePlan, ServiceDirection, TripPosition, TripPurpose,
    };

    fn trip(status: TripStatus, modes: &[TransitMode]) -> ActiveTrip {
        let legs = modes
            .iter()
            .enumerate()
            .map(|(index, mode)| RouteLeg {
                mode: *mode,
                from: Point {
                    x: index as i32,
                    y: 0,
                },
                to: Point {
                    x: index as i32 + 1,
                    y: 0,
                },
                line_id: match mode {
                    TransitMode::Bus => Some("bus-1".to_string()),
                    TransitMode::Metro => Some("metro-1".to_string()),
                    TransitMode::Walk => None,
                },
                service_direction: match mode {
                    TransitMode::Walk => None,
                    TransitMode::Bus | TransitMode::Metro => Some(ServiceDirection::Loop),
                },
                board_itinerary_index: None,
                alight_itinerary_index: None,
            })
            .collect();

        ActiveTrip {
            id: "trip-income-fixture".to_string(),
            sim_id: "sim-income-fixture".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point { x: 0, y: 0 },
            destination: Point {
                x: modes.len() as i32,
                y: 0,
            },
            position: TripPosition {
                x: modes.len() as f64,
                y: 0.0,
            },
            status,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs,
                estimated_seconds: 1.0,
            }),
            current_leg_index: modes.len(),
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }
    }

    #[test]
    fn completed_transit_journey_earns_fixed_income_once() {
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Arrived, &[TransitMode::Bus])),
            200,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Late, &[TransitMode::Metro])),
            200,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(
                TripStatus::Arrived,
                &[TransitMode::Walk, TransitMode::Bus, TransitMode::Metro],
            )),
            200,
        );
    }

    #[test]
    fn non_revenue_trip_shapes_earn_zero() {
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Arrived, &[TransitMode::Walk])),
            0,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Unserved, &[TransitMode::Bus])),
            0,
        );
        assert_eq!(
            completed_transit_trip_income(&trip(TripStatus::Riding, &[TransitMode::Bus])),
            0,
        );

        let mut planless = trip(TripStatus::Arrived, &[TransitMode::Bus]);
        planless.route_plan = None;
        assert_eq!(completed_transit_trip_income(&planless), 0);
    }
}
```

- [ ] **Step 2: Run the qualification tests and verify RED**

```bash
cargo test -p caelum-core transit_income::tests::completed_transit_journey_earns_fixed_income_once
cargo test -p caelum-core transit_income::tests::non_revenue_trip_shapes_earn_zero
```

Expected: compile failure because `completed_transit_trip_income` does not exist and the module is not registered yet.

- [ ] **Step 3: Register the module and implement the minimal pure qualification rule**

In `crates/caelum-core/src/lib.rs`, add beside `operating_cost`:

```rust
pub(crate) mod transit_income;
```

In `transit_income.rs`, add:

```rust
pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32 {
    if !matches!(trip.status, TripStatus::Arrived | TripStatus::Late) {
        return 0;
    }

    let used_transit = trip.route_plan.as_ref().is_some_and(|plan| {
        plan.legs
            .iter()
            .any(|leg| matches!(leg.mode, TransitMode::Bus | TransitMode::Metro))
    });

    if used_transit {
        TRANSIT_TRIP_INCOME
    } else {
        0
    }
}
```

Do not inspect `line_id`, count transit legs, or multiply by transfers.

- [ ] **Step 4: Run the qualification tests and verify GREEN**

```bash
cargo test -p caelum-core transit_income::tests::completed_transit_journey_earns_fixed_income_once
cargo test -p caelum-core transit_income::tests::non_revenue_trip_shapes_earn_zero
```

Expected: PASS.

- [ ] **Step 5: Add failing Standard/Creative settlement tests**

Append:

```rust
#[test]
fn standard_income_can_recover_negative_budget_and_saturates() {
    let mut state = crate::state::create_initial_snapshot();
    state.budget = -100;

    apply_transit_income(&mut state, 200);
    assert_eq!(state.budget, 100);

    state.budget = i32::MAX - 50;
    apply_transit_income(&mut state, 200);
    assert_eq!(state.budget, i32::MAX);
}

#[test]
fn creative_and_non_positive_amounts_do_not_mutate_budget() {
    let mut state = crate::state::create_initial_snapshot();
    state.budget = 123;
    state.rules.economy_preset = EconomyPreset::Creative;
    apply_transit_income(&mut state, 200);
    assert_eq!(state.budget, 123);

    state.rules.economy_preset = EconomyPreset::Standard;
    apply_transit_income(&mut state, 0);
    apply_transit_income(&mut state, -200);
    assert_eq!(state.budget, 123);
}
```

- [ ] **Step 6: Run the settlement tests and verify RED**

```bash
cargo test -p caelum-core transit_income::tests::standard_income_can_recover_negative_budget_and_saturates
cargo test -p caelum-core transit_income::tests::creative_and_non_positive_amounts_do_not_mutate_budget
```

Expected: compile failure because `apply_transit_income` does not exist.

- [ ] **Step 7: Implement minimal preset-aware settlement**

Add:

```rust
pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32) {
    if amount <= 0 || state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }

    state.budget = state.budget.saturating_add(amount);
}
```

Do not import/use `CostPolicy`, `GameMode`, or HPA-645 operating-cost constants.

- [ ] **Step 8: Run all transit-income tests and verify GREEN**

```bash
cargo test -p caelum-core transit_income::tests
```

Expected: PASS.

- [ ] **Step 9: Commit the authority**

```bash
git add crates/caelum-core/src/lib.rs crates/caelum-core/src/transit_income.rs
git commit -m "feat: add transit journey income rule"
```

---

### Task 2: Wire one-shot income into trip resolution

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`

**Interfaces:**
- Consumes: `crate::transit_income::completed_transit_trip_income(&ActiveTrip) -> i32` and `apply_transit_income(&mut GameSnapshot, i32)` from Task 1.
- Produces: every resolution pass credits the aggregate income of trips that became Arrived/Late with Bus/Metro in their retained route plan before terminal trips are removed.

- [ ] **Step 1: Add a local resolvable-trip fixture to `trips.rs` tests**

Inside the existing `#[cfg(test)] mod tests`, extend the model imports with `RouteLeg`, `RoutePlan`, `ServiceDirection`, and `TransitMode`, then add:

```rust
fn resolvable_journey(id: &str, modes: &[TransitMode]) -> ActiveTrip {
    let destination = Point {
        x: modes.len() as i32,
        y: 0,
    };
    ActiveTrip {
        id: id.to_string(),
        sim_id: format!("sim-{id}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 0, y: 0 },
        destination,
        position: destination.into(),
        status: TripStatus::Walking,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: modes
                .iter()
                .enumerate()
                .map(|(index, mode)| RouteLeg {
                    mode: *mode,
                    from: Point {
                        x: index as i32,
                        y: 0,
                    },
                    to: Point {
                        x: index as i32 + 1,
                        y: 0,
                    },
                    line_id: match mode {
                        TransitMode::Bus => Some("bus-1".to_string()),
                        TransitMode::Metro => Some("metro-1".to_string()),
                        TransitMode::Walk => None,
                    },
                    service_direction: match mode {
                        TransitMode::Walk => None,
                        TransitMode::Bus | TransitMode::Metro => Some(ServiceDirection::Loop),
                    },
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                })
                .collect(),
            estimated_seconds: 1.0,
        }),
        current_leg_index: modes.len(),
        patience_remaining: WAIT_PATIENCE_SECONDS,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}
```

The fixture is already at its destination with `current_leg_index` past the final leg, so existing `tick_trip` resolves it through `score_arrival` without constructing a road/transit network. This tests the cash-flow seam, not routing again.

- [ ] **Step 2: Add a failing one-shot Standard wiring test**

```rust
#[test]
fn completed_transit_journey_credits_standard_budget_once() {
    let mut state = create_initial_snapshot();
    state.budget = -100;
    state.active_trips = vec![resolvable_journey(
        "trip-income-standard",
        &[TransitMode::Walk, TransitMode::Bus],
    )];
    let flow = traffic::RoadFlow::new();

    let next = advance_active_trips(&state, &flow, 0.0);

    assert_eq!(next.budget, 100);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips + 1);

    let advanced_again = advance_active_trips(&next, &flow, 0.0);
    assert_eq!(advanced_again.budget, 100);
}
```

- [ ] **Step 3: Add failing Creative, walk-only, and aggregate wiring tests**

```rust
#[test]
fn creative_completion_does_not_credit_budget() {
    let mut state = create_initial_snapshot();
    state.rules.economy_preset = EconomyPreset::Creative;
    state.budget = 123;
    state.active_trips = vec![resolvable_journey(
        "trip-income-creative",
        &[TransitMode::Metro],
    )];

    let next = advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);

    assert_eq!(next.budget, 123);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips + 1);
}

#[test]
fn walking_completion_does_not_credit_budget() {
    let mut state = create_initial_snapshot();
    state.budget = 50;
    state.active_trips = vec![resolvable_journey(
        "trip-income-walk",
        &[TransitMode::Walk],
    )];

    let next = advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);

    assert_eq!(next.budget, 50);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips + 1);
}

#[test]
fn same_resolution_pass_sums_completed_transit_journeys() {
    let mut state = create_initial_snapshot();
    state.budget = 10;
    state.active_trips = vec![
        resolvable_journey("trip-income-bus", &[TransitMode::Bus]),
        resolvable_journey("trip-income-metro", &[TransitMode::Metro]),
    ];

    let next = advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);

    assert_eq!(next.budget, 410);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips + 2);
}
```

Import `EconomyPreset` in the test module if it is not already present.

- [ ] **Step 4: Run the new wiring tests and verify RED**

```bash
cargo test -p caelum-core trips::tests::completed_transit_journey_credits_standard_budget_once
cargo test -p caelum-core trips::tests::creative_completion_does_not_credit_budget
cargo test -p caelum-core trips::tests::walking_completion_does_not_credit_budget
cargo test -p caelum-core trips::tests::same_resolution_pass_sums_completed_transit_journeys
```

Expected: completion/removal assertions pass under existing code, but Standard budget-credit assertions fail because HPA-646 is not wired yet.

- [ ] **Step 5: Aggregate income from resolved results before consuming them**

In `advance_active_trips_with_zero_delta_ids`, after `metric_delta` is built and before `results` is consumed by the existing `for result in results` loop, add:

```rust
let total_transit_income = results.iter().fold(0_i32, |total, result| {
    total.saturating_add(crate::transit_income::completed_transit_trip_income(
        &result.trip,
    ))
});

let mut next = state.clone();
crate::transit_income::apply_transit_income(&mut next, total_transit_income);
```

Replace the existing single `let mut next = state.clone();` at that location rather than introducing a second clone.

Do not change `TripTickResult`, `TripMetricDelta`, `score_arrival`, `update_metrics`, or terminal-trip removal. The new module reads the already-resolved result and mutates only the cloned budget.

- [ ] **Step 6: Run the focused wiring tests and verify GREEN**

```bash
cargo test -p caelum-core trips::tests::completed_transit_journey_credits_standard_budget_once
cargo test -p caelum-core trips::tests::creative_completion_does_not_credit_budget
cargo test -p caelum-core trips::tests::walking_completion_does_not_credit_budget
cargo test -p caelum-core trips::tests::same_resolution_pass_sums_completed_transit_journeys
```

Expected: PASS.

- [ ] **Step 7: Run the full `trips` module test set**

```bash
cargo test -p caelum-core trips::tests
```

Expected: PASS. Existing trip timing, private-car, wait, growth, and granularity tests remain unchanged.

- [ ] **Step 8: Commit trip-resolution wiring**

```bash
git add crates/caelum-core/src/trips.rs
git commit -m "feat: credit completed transit journeys"
```

---

### Task 3: Prove scope stayed narrow and run the Rust regression gate

**Files:**
- No new production files expected.
- Modify only the Task 1/2 files if verification exposes a concrete regression.

**Interfaces:**
- Consumes the complete HPA-646 implementation from Tasks 1-2.
- Produces a review-ready branch with no frontend/wire/persistence expansion and all Rust checks green.

- [ ] **Step 1: Verify the final diff is limited to the planned Rust slice plus planning docs**

```bash
git diff --name-only origin/main...HEAD
```

Expected production/test paths:

```text
crates/caelum-core/src/lib.rs
crates/caelum-core/src/transit_income.rs
crates/caelum-core/src/trips.rs
```

Planning docs already on the draft PR branch are also expected:

```text
docs/superpowers/specs/2026-08-20-minimal-transit-income-design.md
docs/superpowers/plans/2026-08-20-minimal-transit-income.md
```

If `model.rs`, TypeScript/Svelte, persistence, or HPA-645 `operating_cost.rs` changed, review that change critically; the design requires none of them unless a concrete compile/test failure proves otherwise.

- [ ] **Step 2: Run formatting and lint**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 3: Run focused HPA-646 tests together**

```bash
cargo test -p caelum-core transit_income::tests
cargo test -p caelum-core trips::tests
```

Expected: PASS.

- [ ] **Step 4: Run the complete Rust workspace suite**

```bash
cargo test --workspace
```

Expected: PASS.

No new frontend test is required because HPA-646 changes no frontend contract. Do not create a Playwright fare scenario merely to exercise a Rust budget mutation already covered at the authoritative seam.

- [ ] **Step 5: Inspect the final diff for forbidden architecture growth**

```bash
git diff origin/main...HEAD -- crates/caelum-core/src
rg "revenue|profit|ledger|fare" src tests || true
```

Confirm manually:

- no route/line revenue field;
- no daily income accumulator;
- no scheduler/boundary change;
- no `CostPolicy` expansion;
- no new persistence/schema field;
- no TypeScript fare constant/formula;
- transfer journey credits once;
- Creative budget remains unchanged.

- [ ] **Step 6: Commit only if verification required a corrective edit**

If Tasks 1-2 are already green and no file changed during verification, do not create an empty commit. If a concrete correction was required, stage only the affected HPA-646 files and use:

```bash
git add <affected-hpa-646-paths>
git commit -m "fix: tighten transit income regression"
```

- [ ] **Step 7: Update the existing draft PR, not a new PR**

Push the implementation commits to:

```text
jack65786656/hpa-646-phase-5-add-minimal-transit-income-to-prevent-standard
```

Then update the existing HPA-646 draft PR summary/verification. Do not open another PR for this ticket.

---

## Plan self-review

- Every HPA-646 product constraint is assigned to Task 1 or Task 2.
- The one new domain rule has one owner: `transit_income.rs`.
- The integration reuses the existing terminal trip-resolution pass and creates no new time boundary.
- The plan does not add line attribution, wire state, UI state, persistence state, or a generic economy abstraction.
- Test coverage locks qualification separately from wiring, including transfer-once semantics, Creative neutrality, negative-budget recovery, duplicate-credit prevention, and multi-trip aggregation.
- No placeholders or deferred implementation steps remain.
