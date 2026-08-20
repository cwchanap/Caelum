# HPA-646 Minimal Transit Income Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit Standard sandbox `$200` exactly once for each completed journey whose terminal `RoutePlan` used Bus or Metro, giving cities with a surviving usable fleet and existing ridership a direct recovery path from negative budget while Creative remains budget-neutral.

**Architecture:** Add one focused Rust `transit_income` module for the fixed journey-income constant and preset-aware positive settlement. Reuse `trips.rs`'s existing walking-only plan classification through one crate-local `plan_used_transit` wrapper, then aggregate income in `advance_active_trips_with_zero_delta_ids` before terminal trips are removed. Extend the existing real bus lifecycle fixture to prove alight-plan retention, `$200` settlement, and coarse/split budget equivalence; do not add a scheduler, daily accumulator, line attribution, sticky boarding-history field, wire field, frontend formula, persistence field, or route-deletion refund in this PR.

**Tech Stack:** Rust `caelum-core`, existing trip/route-plan model, existing Rust unit and integration tests. No TypeScript/Svelte production change.

**Spec:** `docs/superpowers/specs/2026-08-20-minimal-transit-income-design.md`

## Global Constraints

- `TRANSIT_TRIP_INCOME` is exactly `200`.
- A completed journey earns once when terminal status is `Arrived` or `Late` and the `RoutePlan` present at terminal resolution is not walking-only.
- With today's `TransitMode` model, not walking-only means at least one Bus or Metro leg.
- Reuse `trips.rs::is_walking_only` through one `pub(crate) plan_used_transit(&RoutePlan) -> bool` wrapper; do not duplicate a Bus/Metro mode match in `transit_income.rs`.
- Bus → Metro or other multi-leg transfers earn exactly `$200` once per journey, not once per boarding/line/mode.
- Walk-only, empty-plan, private-car/planless, unserved, and non-terminal trips earn zero.
- Income follows the plan present at terminal resolution, not boarding history. If invalidation/replanning clears the original transit plan and the rider later resolves walk-only or planless, income is `$0`.
- Do not add a sticky `used_transit` flag, settlement marker, or schema field to remember earlier boardings.
- Standard applies positive income immediately at trip resolution and may recover from a negative budget.
- Recovery requires a surviving usable fleet and existing ridership. Deleting the last fleet or reaching negative budget before demand exists remains outside HPA-646.
- Creative never mutates budget for transit income. HPA-645 still shows nominal cost in Creative; HPA-646 intentionally adds no nominal income field.
- Use saturating integer addition for income aggregation and budget settlement.
- The only production caller produces a non-negative aggregate; `apply_transit_income` needs a zero guard, not a negative-amount contract/test.
- Do not use `CostPolicy`; it authorizes capital-purchase deductions.
- Reuse the existing trip-resolution boundary. Add no scheduler, midnight income settlement, `next_boundary_after` source, daily accumulator, or settlement marker.
- Do not add Campaign-specific behavior or tests; Campaign/growth is scheduled for deletion.
- Do not add `ServiceMetrics`, `Metrics`, TypeScript, Svelte, or persistence fields for revenue/profit.
- Snapshot schema remains version 9; no migration or compatibility work.
- Keep `operating_cost.rs` and the transit-income rule separate; do not create a generic economy manager/trait/ledger.
- Route-deletion fleet refund is a separate follow-up candidate, not part of HPA-646.
- One ticket, one PR: implement on the existing HPA-646 draft PR branch only.

---

## Baseline gate

Before production edits, update the implementation checkout and confirm the exact seams still exist:

```bash
git fetch origin
git checkout jack65786656/hpa-646-phase-5-add-minimal-transit-income-to-prevent-standard
git rebase origin/main

rg "fn advance_active_trips_with_zero_delta_ids|fn score_arrival|fn is_walking_only" crates/caelum-core/src/trips.rs
rg "fn disembark_vehicle|fn invalidate_trips_for_line|pub fn delete_route" crates/caelum-core/src/transit.rs
rg "just_disembarked_trip_does_not_consume_ride_time_as_walking_time" crates/caelum-core/tests/trip_lifecycle.rs
rg "GAME_DAY_SECONDS" crates/caelum-core/src/clock.rs
rg "pub struct ActiveTrip|pub struct RoutePlan|pub struct RouteLeg" crates/caelum-core/src/model.rs
rg "apply_day_boundary_charge|BUS_DAILY_OPERATING_COST|METRO_DAILY_OPERATING_COST" crates/caelum-core/src/operating_cost.rs
rg "budget: formatBudget\(state.budget\)" src/runtime/runtimeSelectors.ts
```

Run the pre-change focused tests:

```bash
cargo test -p caelum-core trips::tests
cargo test -p caelum-core operating_cost::tests
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
```

Expected: PASS before HPA-646 production edits.

---

## File map

### Rust production

- Create `crates/caelum-core/src/transit_income.rs` — fixed journey-income constant, terminal-trip qualification, and Standard/Creative budget settlement.
- Modify `crates/caelum-core/src/lib.rs` — register `transit_income` as `pub(crate)` before the new module tests are run.
- Modify `crates/caelum-core/src/trips.rs` — expose the existing walking-only classification through `plan_used_transit`, aggregate income from resolved trip results, and apply it once before terminal results are consumed.

### Rust tests

- Add unit tests beside production code in `crates/caelum-core/src/transit_income.rs` — exact qualification and settlement semantics, including empty/planless zero-income behavior.
- Add focused cash-flow wiring regressions in the existing `#[cfg(test)]` module in `crates/caelum-core/src/trips.rs` — one-shot credit, Creative, walking-only, and multi-trip aggregation.
- Modify `crates/caelum-core/tests/trip_lifecycle.rs` — extend the existing real bus disembark fixture with a pre-wiring route-plan-retention GREEN lock, post-wiring `$200` settlement, and coarse/split budget equivalence.

### Explicitly unchanged

- `crates/caelum-core/src/model.rs` — no `used_transit`, revenue, wire, or schema field.
- `crates/caelum-core/src/operating_cost.rs` — HPA-645 cost behavior stays independent.
- `crates/caelum-core/src/transit.rs` — no route-delete refund in this task.
- `src/**` and top-level `tests/**` TypeScript/Svelte — existing budget projection already makes Standard income visible; no new UI contract.
- persistence adapters/normalization — budget already persists.

---

### Task 1: Add the transit-income authority and share plan classification

**Files:**
- Create: `crates/caelum-core/src/transit_income.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/trips.rs`

**Interfaces:**
- Consumes: `model::ActiveTrip`, `EconomyPreset`, `GameSnapshot`, `RoutePlan`, `TripStatus`, plus existing `trips::is_walking_only` semantics.
- Produces:

```rust
// crates/caelum-core/src/trips.rs
pub(crate) fn plan_used_transit(route_plan: &RoutePlan) -> bool;

// crates/caelum-core/src/transit_income.rs
pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;
pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32;
pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32);
```

- [ ] **Step 1: Register the new module and create failing qualification tests**

First add the module declaration beside `operating_cost` in `crates/caelum-core/src/lib.rs`:

```rust
pub(crate) mod transit_income;
```

Then create `crates/caelum-core/src/transit_income.rs` with imports, the constant, and tests, but no production function bodies yet:

```rust
use crate::model::{ActiveTrip, EconomyPreset, GameSnapshot, TripStatus};

pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Point, RouteLeg, RoutePlan, ServiceDirection, TransitMode, TripPosition, TripPurpose,
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
        assert_eq!(completed_transit_trip_income(&trip(TripStatus::Arrived, &[])), 0);
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

The empty-plan assertion locks the existing `is_walking_only` convention: `all` over zero legs is true, so its inverse must be false.

- [ ] **Step 2: Run the qualification tests and verify a real RED**

```bash
cargo test -p caelum-core transit_income::tests::completed_transit_journey_earns_fixed_income_once
cargo test -p caelum-core transit_income::tests::non_revenue_trip_shapes_earn_zero
```

Expected: compile failure for missing `completed_transit_trip_income`. The module is already registered, so this must not report `0 tests` and exit successfully.

- [ ] **Step 3: Expose only the semantic inverse of the existing walking-only predicate**

In `crates/caelum-core/src/trips.rs`, immediately beside the existing `is_walking_only` helper, add only:

```rust
pub(crate) fn plan_used_transit(route_plan: &RoutePlan) -> bool {
    !is_walking_only(route_plan)
}
```

Do not rewrite the existing `is_walking_only` body. Do not add a second `Bus | Metro` match and do not extract a route-plan evaluator module.

- [ ] **Step 4: Implement the minimal pure qualification rule**

In `transit_income.rs`, add:

```rust
pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32 {
    if !matches!(trip.status, TripStatus::Arrived | TripStatus::Late) {
        return 0;
    }

    if trip
        .route_plan
        .as_ref()
        .is_some_and(crate::trips::plan_used_transit)
    {
        TRANSIT_TRIP_INCOME
    } else {
        0
    }
}
```

Do not inspect `line_id`, historical vehicle membership, or count transit legs/transfers. The plan present at terminal resolution is the whole qualification input.

- [ ] **Step 5: Run the qualification tests and verify GREEN**

```bash
cargo test -p caelum-core transit_income::tests::completed_transit_journey_earns_fixed_income_once
cargo test -p caelum-core transit_income::tests::non_revenue_trip_shapes_earn_zero
```

Expected: PASS.

- [ ] **Step 6: Add failing Standard/Creative settlement tests**

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
fn creative_and_zero_amount_do_not_mutate_budget() {
    let mut state = crate::state::create_initial_snapshot();
    state.budget = 123;
    state.rules.economy_preset = EconomyPreset::Creative;
    apply_transit_income(&mut state, 200);
    assert_eq!(state.budget, 123);

    state.rules.economy_preset = EconomyPreset::Standard;
    apply_transit_income(&mut state, 0);
    assert_eq!(state.budget, 123);
}
```

Do not add a negative-amount test; the only production caller cannot produce a negative aggregate.

- [ ] **Step 7: Run the settlement tests and verify RED**

```bash
cargo test -p caelum-core transit_income::tests::standard_income_can_recover_negative_budget_and_saturates
cargo test -p caelum-core transit_income::tests::creative_and_zero_amount_do_not_mutate_budget
```

Expected: compile failure because `apply_transit_income` does not exist.

- [ ] **Step 8: Implement minimal preset-aware settlement**

Add:

```rust
pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32) {
    if amount == 0 || state.rules.economy_preset == EconomyPreset::Creative {
        return;
    }

    state.budget = state.budget.saturating_add(amount);
}
```

The caller invariant is non-negative aggregation from `0`/`200` results. Do not import/use `CostPolicy`, `GameMode`, or HPA-645 operating-cost constants.

- [ ] **Step 9: Run all transit-income tests and verify GREEN**

```bash
cargo test -p caelum-core transit_income::tests
```

Expected: PASS.

- [ ] **Step 10: Commit the authority and shared predicate**

```bash
git add crates/caelum-core/src/lib.rs crates/caelum-core/src/transit_income.rs crates/caelum-core/src/trips.rs
git commit -m "feat: add transit journey income rule"
```

---

### Task 2: Wire one-shot income and lock the real alight path

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`

**Interfaces:**
- Consumes: `crate::transit_income::completed_transit_trip_income(&ActiveTrip) -> i32` and `apply_transit_income(&mut GameSnapshot, i32)` from Task 1.
- Produces: every resolution pass credits the aggregate income of trips that became Arrived/Late with a transit-bearing terminal plan before terminal trips are removed; the existing real bus lifecycle proves actual alighting retains the qualifying plan and credits identically across coarse/split tick shapes.

- [ ] **Step 1: Add a local synthetic resolvable-trip fixture and cash-flow tests**

Inside the existing `#[cfg(test)] mod tests` in `crates/caelum-core/src/trips.rs`, add the required imports and fixture:

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

Add these focused tests:

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

#[test]
fn creative_and_walking_completions_do_not_credit_budget() {
    let mut creative = create_initial_snapshot();
    creative.rules.economy_preset = EconomyPreset::Creative;
    creative.budget = 123;
    creative.active_trips = vec![resolvable_journey(
        "trip-income-creative",
        &[TransitMode::Metro],
    )];

    let creative_next =
        advance_active_trips(&creative, &traffic::RoadFlow::new(), 0.0);
    assert_eq!(creative_next.budget, 123);
    assert_eq!(
        creative_next.metrics.completed_trips,
        creative.metrics.completed_trips + 1
    );

    let mut walking = create_initial_snapshot();
    walking.budget = 50;
    walking.active_trips = vec![resolvable_journey(
        "trip-income-walk",
        &[TransitMode::Walk],
    )];

    let walking_next =
        advance_active_trips(&walking, &traffic::RoadFlow::new(), 0.0);
    assert_eq!(walking_next.budget, 50);
    assert_eq!(
        walking_next.metrics.completed_trips,
        walking.metrics.completed_trips + 1
    );
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

These synthetic tests isolate settlement and duplicate-credit behavior; they do not prove actual vehicle alighting.

- [ ] **Step 2: Run the synthetic cash-flow tests and verify RED**

```bash
cargo test -p caelum-core trips::tests::completed_transit_journey_credits_standard_budget_once
cargo test -p caelum-core trips::tests::creative_and_walking_completions_do_not_credit_budget
cargo test -p caelum-core trips::tests::same_resolution_pass_sums_completed_transit_journeys
```

Expected before wiring: trip completion/removal behavior is otherwise valid, but Standard budget-credit assertions fail because HPA-646 is not integrated yet.

- [ ] **Step 3: Add only the real-alight plan-retention assertion and observe GREEN before income wiring**

In `crates/caelum-core/tests/trip_lifecycle.rs::just_disembarked_trip_does_not_consume_ride_time_as_walking_time`, after the existing post-alight assertions:

```rust
assert_eq!(walking.status, TripStatus::Walking);
assert_eq!(walking.current_leg_index, 1);
assert_eq!(walking.position, (12, 4).into());
```

add only:

```rust
assert!(walking.route_plan.as_ref().is_some_and(|plan| {
    plan.legs.iter().any(|leg| leg.mode == TransitMode::Bus)
}));
```

Run just this test **before adding any budget expectation**:

```bash
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
```

Expected: PASS. This is the explicit pre-change proof that real `disembark_vehicle` currently preserves the Bus-bearing plan HPA-646 depends on.

- [ ] **Step 4: Add the real arrival-income and coarse/split budget locks and observe RED**

In the same lifecycle test, immediately after obtaining `vehicle.snapshot`, capture the post-construction Standard budget:

```rust
let mut state = vehicle.snapshot;
let starting_budget = state.budget;
state.paused = false;
```

Keep the existing coarse and split disembark states. At the final arrival stage, advance **both**:

```rust
let coarse_arrived = tick_trips(&coarse_disembarked, &topology, 20.0);
let arrived = tick_trips(&disembarked, &topology, 20.0);
```

Add:

```rust
assert_eq!(arrived.budget, starting_budget + 200);
assert_eq!(coarse_arrived.budget, arrived.budget);
```

Then run:

```bash
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
```

Expected before wiring: FAIL on `starting_budget + 200`; the earlier route-plan retention proof was already observed GREEN in Step 3.

This fixture reaches final arrival at about `32.5s` at speed 1, while `GAME_DAY_SECONDS == 1_200`, so HPA-645's midnight operating charge cannot perturb the expected `+200`.

- [ ] **Step 5: Wire aggregate income from resolved results before consuming them**

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

Do not change `TripTickResult`, `TripMetricDelta`, `score_arrival`, `update_metrics`, `disembark_vehicle`, or terminal-trip removal. The new module reads the already-resolved result and mutates only the cloned budget.

- [ ] **Step 6: Run all HPA-646 wiring/alight tests and verify GREEN**

```bash
cargo test -p caelum-core trips::tests::completed_transit_journey_credits_standard_budget_once
cargo test -p caelum-core trips::tests::creative_and_walking_completions_do_not_credit_budget
cargo test -p caelum-core trips::tests::same_resolution_pass_sums_completed_transit_journeys
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
```

Expected: PASS, including:

- one-shot Standard credit;
- Creative neutrality;
- walk-only zero income;
- two-trip `$400` aggregation;
- real alight plan retention;
- real arrival `+200`;
- coarse/split final budget equality.

- [ ] **Step 7: Run the broader trip regression sets**

```bash
cargo test -p caelum-core trips::tests
cargo test -p caelum-core --test trip_lifecycle
```

Expected: PASS. Existing trip timing, private-car, wait, boarding/alighting, growth, and granularity behavior remains unchanged.

- [ ] **Step 8: Commit trip-resolution wiring and lifecycle regression**

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/tests/trip_lifecycle.rs
git commit -m "feat: credit completed transit journeys"
```

---

### Task 3: Prove scope stayed narrow and run the Rust regression gate

**Files:**
- No new production files expected.
- Modify only Task 1/2 files if verification exposes a concrete regression.

**Interfaces:**
- Consumes the complete HPA-646 implementation from Tasks 1-2.
- Produces a review-ready branch with no frontend/wire/persistence expansion and all Rust checks green.

- [ ] **Step 1: Verify the final diff is limited to the planned slice plus planning docs**

```bash
git diff --name-only origin/main...HEAD
```

Expected production/test paths:

```text
crates/caelum-core/src/lib.rs
crates/caelum-core/src/transit_income.rs
crates/caelum-core/src/trips.rs
crates/caelum-core/tests/trip_lifecycle.rs
```

Planning docs are also expected:

```text
docs/superpowers/specs/2026-08-20-minimal-transit-income-design.md
docs/superpowers/plans/2026-08-20-minimal-transit-income.md
```

If `model.rs`, `transit.rs`, TypeScript/Svelte, persistence, or HPA-645 `operating_cost.rs` changed, review that change critically; the approved HPA-646 design requires none of them.

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
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
```

Expected: PASS.

- [ ] **Step 4: Run the complete Rust workspace suite**

```bash
cargo test --workspace
```

Expected: PASS.

No new frontend test is required because HPA-646 changes no frontend contract. Do not create a Playwright fare scenario merely to exercise a Rust budget mutation already covered at the authoritative seam and the real Rust bus lifecycle.

- [ ] **Step 5: Inspect the final diff for forbidden architecture growth**

```bash
git diff origin/main...HEAD -- crates/caelum-core/src crates/caelum-core/tests/trip_lifecycle.rs
rg "revenue|profit|ledger|fare|used_transit" src tests crates/caelum-core/src/model.rs || true
```

Confirm manually:

- no route/line revenue field;
- no daily income accumulator;
- no scheduler/boundary change;
- no `CostPolicy` expansion;
- no sticky boarding-history / `used_transit` model field;
- no route-delete refund bundled into HPA-646;
- no new persistence/schema field;
- no TypeScript fare constant/formula;
- transfer journey credits once;
- invalidated/replanned completion is classified only from its terminal plan;
- Creative budget remains unchanged and no nominal income field was added;
- the documented recovery preconditions remain honest: surviving fleet + ridership.

- [ ] **Step 6: Commit only if verification required a corrective edit**

If Tasks 1-2 are already green and no file changed during verification, do not create an empty commit. If a concrete correction was required, stage only the affected HPA-646 files and use:

```bash
git add <affected-hpa-646-paths>
git commit -m "fix: tighten transit income regression"
```

- [ ] **Step 7: Update the existing draft PR, not a new PR**

Push implementation commits to:

```text
jack65786656/hpa-646-phase-5-add-minimal-transit-income-to-prevent-standard
```

Then update the existing HPA-646 draft PR summary/verification. Do not open another PR for this ticket.

---

## Plan self-review

- Task 1's first RED is real because `transit_income` is registered before its tests are run.
- The one new domain rule has one owner: `transit_income.rs`; existing walking-only plan classification remains owned by `trips.rs`.
- `apply_transit_income` handles only the reachable zero/positive aggregate contract; no negative-income branch/test is invented.
- The integration reuses the existing terminal trip-resolution pass and creates no new time boundary.
- Qualification explicitly follows the terminal plan, so line invalidation/stranded replan behavior does not silently imply a new persisted boarding-history requirement.
- The real alight dependency is observed GREEN before the income assertion is introduced, then the income assertion is observed RED before wiring.
- The existing real bus lifecycle locks coarse/split final budget equality in addition to plan retention and `$200` settlement.
- The plan does not add line attribution, wire state, UI state, persistence state, route deletion refund, or a generic economy abstraction.
- Creative's cost-visible/income-not-surfaced asymmetry is intentional and documented.
- Recovery is explicitly conditional on a surviving usable fleet and existing ridership; the plan no longer claims universal negative-budget recovery.
- No placeholders or deferred implementation steps remain.
