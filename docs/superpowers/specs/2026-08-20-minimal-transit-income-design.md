# HPA-646 Minimal Transit Income Design

**Linear:** HPA-646  
**Parent:** HPA-335  
**Related:** HPA-645

## Goal

Add the smallest ridership-based recovery path after HPA-645 made daily Bus/Metro operating cost real:

> Each successfully completed journey whose terminal `RoutePlan` used Bus or Metro earns a fixed city-level `$200` fare/subsidy. Standard adds that amount to budget immediately when the trip completes; Creative keeps budget unchanged.

This removes the one-way budget drain for a Standard city that still has an operational fleet and existing ridership. It does **not** guarantee recovery from every negative-budget state: deleting the last usable fleet or reaching negative budget before demand exists can still leave the city unable to generate transit income. Those limits are explicit below rather than hidden behind a broader “soft-lock solved” claim.

This is intentionally not route accounting. Revenue belongs to the city, not to a line, vehicle, transfer, fare zone, or accounting period. The existing budget is the only persisted financial state.

## Verified baseline and reuse

Current `main` already provides every seam needed for this slice:

- HPA-645 owns daily Bus/Metro operating cost in `crates/caelum-core/src/operating_cost.rs`: Bus is `$400 / vehicle / game day`, Metro is `$2,500 / vehicle / game day`.
- Standard deducts actual city-wide operating cost at the existing midnight boundary; Creative publishes the same nominal costs without mutating budget.
- `crates/caelum-core/src/trips.rs::advance_active_trips_with_zero_delta_ids` is the single trip-resolution pass. It already has every `TripTickResult` before terminal trips are removed and before metrics are finalized.
- `score_arrival` marks both on-time `Arrived` and `Late` journeys as completed and does not clear the `RoutePlan` it receives. `Unserved` trips do not increment completed trips.
- The normal vehicle alight path in `transit::disembark_vehicle` sets the rider back to `Walking`, advances `current_leg_index`, and leaves `route_plan` intact. The existing `just_disembarked_trip_does_not_consume_ride_time_as_walking_time` lifecycle fixture already exercises Riding → alight → final Walk → Arrived on a real bus route.
- Route-plan retention is not universal. `tick_trip` clears a `Riding` trip's plan when it is no longer on a vehicle and must recover/replan, and `transit::invalidate_trips_for_line` clears plans that reference an invalidated line. HPA-646 therefore classifies the plan present at terminal resolution, not historical boardings.
- Each `RouteLeg` already identifies its `TransitMode`. Today the plan modes are Walk, Bus, and Metro; `trips.rs::is_walking_only` already owns the existing “all legs are Walk” predicate.
- Private-car trips use `private_car_trip` and do not carry a transit route plan. Walking-only plans contain only `TransitMode::Walk` legs.
- The Topbar already renders authoritative `GameSnapshot.budget`. A Rust budget credit is therefore player-visible without a new frontend formula or wire field.
- `GameSnapshot.budget` is persisted already. Crediting it requires no new save field and no snapshot-schema bump.
- `transit::delete_route` removes the route's assigned vehicles with no refund. At negative budget those vehicles cannot simply be bought back through the normal affordability-gated purchase path.
- New residents move into placed housing, and building placement is affordability-gated in Standard. A city that goes negative before it has housing/ridership can therefore lack the demand needed to earn this income.
- Route pause is the safe recovery lever that exists today: it stops HPA-645 actual operating cost while preserving the route/fleet for later service. Route deletion is not equivalent because it destroys the assigned fleet.

## Approaches considered

### A. Fixed income per completed transit journey — chosen

On terminal trip resolution, inspect the completed trip's existing `RoutePlan`. If that terminal plan is not walking-only, credit one fixed city-level amount.

Advantages:

- directly rewards actual successful ridership;
- uses an existing deterministic trip-completion seam;
- requires no scheduler, accumulator, daily history, or line attribution;
- transfer journeys naturally count once rather than once per boarding;
- walking, private-car, and unserved demand naturally pay nothing;
- preserves HPA-645's service-planning pressure instead of guaranteeing profitability.

This is the smallest rule that creates a useful recovery path without turning Phase 5 into a finance subsystem.

### B. Flat daily city subsidy — rejected

A fixed grant at midnight would pay the player even when no transit trip is served. It would weaken the connection between service usefulness and cash flow and could mask an oversized fleet. It also would not address the route-deletion trap cleanly; it would merely paper over it with unrelated income.

### C. Per-boarding or per-line fare — rejected

Charging every boarding or attributing revenue to individual lines would require transfer semantics and eventually route profitability. HPA-646 has no player-facing consumer for that attribution. A Bus → Metro journey should not earn twice merely because it transfers.

## Chosen tuning constant

Add one independent balance constant:

```rust
pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;
```

The amount is not derived from purchase prices or daily operating-cost constants.

Initial balance rationale:

- one Bus costs `$400 / day`; one worker completing an outbound and return transit journey contributes `$400 / day`, so one reliable commuter can offset one Bus-day;
- one Metro vehicle costs `$2,500 / day`; 13 completed transit journeys cover one train-day, so Metro still requires materially more ridership;
- the current Small Town template has two Small Houses with four residents each, so its eventual eight workers can generate up to 16 completed commute journeys per day. A well-used single-train Metro can therefore become sustainable, while an oversized multi-train service remains a real cost choice.

This is an initial tuning value, not a generic fare model. If playtesting later shows it is too high or low, change this constant directly.

## Exactly what earns income

A trip earns exactly `$200` when both are true:

1. its terminal status is `TripStatus::Arrived` or `TripStatus::Late`; and
2. the `RoutePlan` still present at terminal resolution is not walking-only.

With the current `TransitMode` model, “not walking-only” means the retained plan contains at least one Bus or Metro leg. Reuse the same predicate as `trips.rs::is_walking_only`; do not hand-roll a second Bus/Metro mode scan inside the income module.

Everything else earns zero:

- `Unserved` trip;
- walking-only completed trip;
- private-car completed trip;
- an empty, malformed, or planless terminal trip;
- any non-terminal trip.

A journey with multiple transit legs or transfers earns once total:

```text
Walk → Bus → Walk                    = $200
Walk → Metro → Walk                  = $200
Walk → Bus → Walk → Metro → Walk     = $200
Walk only                            = $0
Private car                          = $0
Unserved Bus/Metro attempt           = $0
Boarded transit → plan cleared → walk-only/planless completion = $0
```

Income follows the plan present at terminal resolution, not boarding history. If line invalidation or stranded-rider recovery clears the original transit plan and the rider later finishes with a walk-only or empty/planless terminal plan, that completion earns `$0`. This is intentional for HPA-646; do not add a sticky `used_transit` flag, settlement marker, or schema field merely to preserve pre-invalidation boarding history. If playtesting later says those disrupted journeys should still pay, that is a separate product rule.

Late journeys still earn income because the passenger completed the transit journey. Lateness remains visible through existing metrics; withholding the fare for a late arrival would add a second quality/pricing rule with no current product need.

## Share the existing plan predicate

Keep `trips.rs::is_walking_only` as the one mode-classification implementation and add only its semantic inverse beside it:

```rust
pub(crate) fn plan_used_transit(route_plan: &RoutePlan) -> bool {
    !is_walking_only(route_plan)
}
```

`completed_transit_trip_income` calls this helper. This preserves the existing empty-plan convention (`all` over zero legs is true, therefore “used transit” is false) without duplicating a `Bus | Metro` match in a second module.

Do not extract a route-plan evaluator or new domain module for one inverse predicate.

## Settlement timing

Credit income immediately in the existing trip-resolution pass, not at midnight.

This avoids a persisted daily-revenue accumulator and keeps the rule tied to the exact event that justifies it. The tick engine already subdivides time around trip/vehicle boundaries, so immediate settlement remains deterministic across coarse and split ticks.

In `advance_active_trips_with_zero_delta_ids`:

1. produce all `TripTickResult`s as today;
2. sum `completed_transit_trip_income(&result.trip)` across those results with saturating addition;
3. clone `state` to the candidate `next` snapshot;
4. apply the one aggregate income amount to `next`;
5. continue the existing terminal-trip removal, Sim arrival/resolution, and metrics update unchanged.

Do not add an income boundary to `next_boundary_after`. Trip completion is already a tracked simulation boundary.

## Standard and Creative semantics

Standard applies positive income directly to the authoritative budget:

```rust
state.budget = state.budget.saturating_add(amount);
```

This intentionally works from a negative budget. For example, `-100 + 200 = 100`, restoring capital-purchase eligibility once enough qualifying ridership completes.

The only production caller folds `0`/`200` qualification results with saturating addition, so the aggregate is non-negative by construction. `apply_transit_income` only needs to return early for `amount == 0` and Creative; do not add a negative-amount contract or test that no caller can produce.

Creative remains budget-neutral. HPA-645 still shows nominal daily operating cost in Creative, while HPA-646 intentionally does **not** add a nominal income/revenue field. That produces a known temporary asymmetry: Creative can see cost but not a separate income figure. The existing budget remains unchanged, and there is no current player-facing requirement for projected revenue or profit, so adding a wire/UI field only for symmetry is deferred.

Do not route income through `CostPolicy`: that abstraction authorizes capital deductions, while HPA-646 is an unconditional positive settlement for a completed simulation outcome.

Do not add Campaign-specific behavior or tests. Campaign/growth is scheduled for deletion and new work should not preserve a second economy contract for it.

## Rust module boundary

Create one focused module:

`crates/caelum-core/src/transit_income.rs`

Its complete production surface is:

```rust
use crate::model::{ActiveTrip, EconomyPreset, GameSnapshot, TripStatus};

pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32;

pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32);
```

`completed_transit_trip_income` owns only terminal-status qualification plus the call to `crate::trips::plan_used_transit`. It does not mutate state and does not know route objects, fleet size, operating cost, line profitability, or boarding history.

`apply_transit_income` owns only preset-aware budget settlement:

- return for `amount == 0`;
- return for Creative;
- Standard uses `saturating_add`.

Register the module as `pub(crate)` in `crates/caelum-core/src/lib.rs` before running the new module's RED tests so Cargo actually compiles them.

Keep this separate from `operating_cost.rs`. Cost and income are two concrete rules with different triggering events; combining them into a generic economy manager, ledger, recurring rule trait, or transaction framework would add structure without a second consumer.

## Trip-resolution integration

The production change in `trips.rs` should remain small and local:

```rust
let total_transit_income = results.iter().fold(0_i32, |total, result| {
    total.saturating_add(crate::transit_income::completed_transit_trip_income(
        &result.trip,
    ))
});

let mut next = state.clone();
crate::transit_income::apply_transit_income(&mut next, total_transit_income);
```

Then preserve the existing result-consumption loop and metric update.

Compute income from the resolved trip before terminal trips are removed. Do not infer it from `completed_trips` alone because that would incorrectly pay walking and private-car journeys. Do not infer it from vehicle passenger lists after alighting because the passenger may already have disembarked when the overall journey completes.

The normal alight path is an important dependency, not an assumption to leave implicit: after `disembark_vehicle`, the terminal result must still carry the Bus/Metro-containing plan. The implementation regression suite must lock that on the existing real bus lifecycle fixture.

## Player-visible output and the Creative asymmetry

HPA-646 does not need a frontend production change:

- `Topbar.svelte` already displays `state.budget` through `ShellTopbarState.budget`;
- the budget is already Rust-owned and host-neutral;
- `dailyOperatingCost` continues to show current nominal cost from HPA-645, including in Creative;
- HPA-646 adds no `dailyIncome`, `revenue`, `profit`, or route-revenue field.

This means Creative displays nominal cost but not nominal income. That asymmetry is accepted for this minimal slice because Creative's budget is intentionally neutral and there is no current UI action driven by a revenue number. If a future operating-result view is selected, it can add the smallest Rust-owned nominal income projection then.

Do not add fields to `ServiceMetrics`, `Metrics`, `ShellTopbarState`, route rows, TypeScript domain types, or persistence just to make the two numbers visually symmetric.

No snapshot schema bump and no save migration. A save simply contains whatever Standard budget the simulation has earned so far.

## Recovery behavior and intentional limits

HPA-646 creates a recovery path; it does not make every negative-budget state recoverable.

The recovery preconditions are:

1. at least one usable transit fleet still exists; and
2. enough existing residents/workers can generate qualifying completed transit journeys.

The intended player lever is **pause, do not delete**:

- pausing a route stops HPA-645 actual daily operating cost while preserving the route and assigned vehicles;
- resuming useful service later can generate `$200` completed-journey income;
- an oversized fleet can still lose money, which is intended service-planning pressure.

Two reachable states remain outside this slice:

- **Deleted last fleet while negative.** `delete_route` removes its vehicles with no refund. If the city cannot afford replacement vehicles, transit income cannot restart.
- **Negative before demand exists.** Transit income needs completed commutes; residents need housing; Standard housing placement is affordability-gated. A city that spent into service before establishing demand can still strand itself.

Do not solve either case with a flat subsidy, loan, bankruptcy rule, sticky income history, or generic finance system.

Recommended separate follow-up if playtesting confirms the route-deletion trap: refund the assigned fleet's capital value when deleting a route/line, in the existing `delete_route` path, without building a general sale/scrap system. That is deliberately **not** part of HPA-646.

HPA-646 also does not preserve historical “used transit” state across route invalidation/replanning; qualification remains based on the terminal plan only.

## Determinism and duplicate-credit behavior

No new identity or settlement marker is needed.

A completed trip is terminal and is removed from `active_trips` during the same `advance_active_trips_with_zero_delta_ids` call in which income is credited. Re-advancing the returned snapshot therefore cannot encounter that trip and cannot credit it twice.

Save/restore needs no special handling: the budget already contains the credit and the completed trip is absent from the saved active-trip set.

Coarse and equivalent split ticks must finish with the same budget. The real bus lifecycle fixture already has one coarse disembark path and one split disembark path in scope; HPA-646 extends that same fixture through final arrival and compares the resulting budgets.

The lifecycle fixture reaches arrival at about `32.5s` at speed 1, while `GAME_DAY_SECONDS == 1_200`. Therefore the expected `+200` cannot be confused with HPA-645's midnight operating-cost charge.

## Verification strategy

### Transit-income authority

Unit tests in `transit_income.rs` lock:

- Arrived Bus journey = `$200`;
- Late Metro journey = `$200`;
- Bus → Metro transfer journey = `$200` once;
- walking-only Arrived journey = `$0`;
- empty-plan and planless/private-car Arrived journeys = `$0`;
- Unserved transit journey = `$0`;
- non-terminal transit journey = `$0`;
- Standard can recover from negative budget through positive settlement;
- Creative budget is unchanged;
- zero aggregate does not mutate budget;
- addition saturates rather than overflowing.

Negative income is not a test case because the only production caller cannot produce it.

### Trip-resolution wiring

Focused `trips.rs` tests prove the cash-flow integration without rebuilding routing:

1. a terminal transit-bearing synthetic journey credits exactly `$200` and is removed;
2. advancing the returned snapshot again does not credit twice;
3. equivalent Creative completion changes trip/metrics state but not budget;
4. equivalent walking-only completion increments completed trips but credits `$0`;
5. two qualifying trips resolving in one pass credit `$400`.

These synthetic tests lock the settlement seam only. They are not sufficient proof that the real ride lifecycle still presents a transit-bearing plan at terminal resolution.

### Real alight and granularity regression

Extend `crates/caelum-core/tests/trip_lifecycle.rs::just_disembarked_trip_does_not_consume_ride_time_as_walking_time` rather than building a second network:

1. **Before income wiring**, add only the post-alight `walking.route_plan` Bus-leg assertion and run the focused test. It must be GREEN on the existing behavior; this independently proves the dependency HPA-646 relies on.
2. Then capture the Standard budget after route/vehicle construction and add the expected final `starting_budget + 200` assertion. Run again before wiring; this must be RED because HPA-646 has not settled income yet.
3. Keep both the existing coarse disembark snapshot and the split disembark snapshot. Advance each through the same final arrival interval and assert their final budgets are equal.
4. After wiring, the retained-plan, `+200`, and coarse/split budget assertions must all be GREEN.

This is the one end-to-end lock that protects HPA-646 from an alight change that clears `route_plan` and from a granularity regression that would credit one tick shape differently from another.

### Regression gate

Run focused tests first, then the normal Rust workspace gate:

```bash
cargo test -p caelum-core transit_income
cargo test -p caelum-core trips::tests
cargo test -p caelum-core --test trip_lifecycle just_disembarked_trip_does_not_consume_ride_time_as_walking_time
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Because no TypeScript/Svelte production contract changes, frontend tests do not need new cases. Run the existing repository checks before final merge if the implementation workflow requires the full project gate.

## Non-goals

- universal recovery from every negative-budget state;
- route deletion refund in HPA-646;
- per-line, per-route, per-mode, per-vehicle, or per-transfer revenue attribution;
- configurable fares or player fare controls;
- distance/time-based fares;
- passenger classes, fare zones, discounts, or dynamic pricing;
- route profit/loss or net operating-result metrics;
- daily revenue counters, accounting periods, ledgers, transaction history, charts, or finance dashboard;
- nominal Creative income output solely for symmetry;
- subsidies unrelated to completed ridership;
- preserving pre-invalidation/pre-replan boarding history with a sticky `used_transit` flag or new persisted trip field;
- taxation, loans, bonds, debt servicing, bankruptcy, or game-over rules;
- fleet sale, withdrawal, reassignment, refund, or automatic optimization;
- a generic economy engine/framework/trait/registry;
- scheduler or additional tick boundaries;
- schema migration, compatibility adapter, or feature flag.
