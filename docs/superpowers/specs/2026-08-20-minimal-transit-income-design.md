# HPA-646 Minimal Transit Income Design

**Linear:** HPA-646  
**Parent:** HPA-335  
**Related:** HPA-645

## Goal

Close the temporary Standard-sandbox soft-lock introduced by HPA-645 with one small positive cash-flow rule:

> Each successfully completed journey that used Bus or Metro earns a fixed city-level $200 fare/subsidy. Standard adds that amount to budget immediately when the trip completes; Creative keeps budget unchanged.

This is intentionally not route accounting. Revenue belongs to the city, not to a line, vehicle, transfer, fare zone, or accounting period. The existing budget is the only persisted financial state.

## Verified baseline and reuse

Current `main` already provides every seam needed for this slice:

- HPA-645 is merged and owns daily Bus/Metro operating cost in `crates/caelum-core/src/operating_cost.rs`: Bus is `$400 / vehicle / game day`, Metro is `$2,500 / vehicle / game day`.
- Standard deducts the actual city-wide operating cost at the existing midnight boundary; Creative publishes the same nominal costs without mutating budget.
- `crates/caelum-core/src/trips.rs::advance_active_trips_with_zero_delta_ids` is the single trip-resolution pass. It already has every `TripTickResult` before terminal trips are removed and before metrics are finalized.
- `score_arrival` marks both on-time `Arrived` and `Late` journeys as completed. `Unserved` trips do not increment completed trips.
- A successful non-car trip retains its `RoutePlan` through resolution. Each `RouteLeg` already identifies its `TransitMode` and optional `line_id`.
- Private-car trips use `private_car_trip` and do not carry a transit route plan. Walking-only plans contain only `TransitMode::Walk` legs.
- The top bar already renders authoritative `GameSnapshot.budget`. A Rust budget credit is therefore player-visible without a new frontend formula or wire field.
- `GameSnapshot.budget` is persisted already. Crediting it requires no new save field and no snapshot-schema bump.
- Route pause already makes HPA-645 actual daily operating cost zero, so a player can stop further recurring loss while rebuilding positive cash flow from useful service later.

## Approaches considered

### A. Fixed income per completed transit journey — chosen

On terminal trip resolution, inspect the completed trip's existing `RoutePlan`. If it used at least one Bus or Metro leg, credit one fixed city-level amount.

Advantages:

- directly rewards actual successful ridership;
- uses an existing deterministic trip-completion seam;
- requires no scheduler, accumulator, daily history, or line attribution;
- transfer journeys naturally count once rather than once per boarding;
- walking, private-car, and unserved demand naturally pay nothing;
- the player can understand the relationship between useful transit and financial recovery.

This is the smallest rule that both creates positive cash flow and preserves the operating-pressure signal added by HPA-645.

### B. Flat daily city subsidy — rejected

A fixed grant at midnight would be simpler mechanically, but it would pay the player even when no transit trip is served. It weakens the player-facing connection between service quality/ridership and the economy and can mask an oversized fleet without requiring useful operation.

### C. Per-boarding or per-line fare — rejected

Charging every boarding or attributing revenue to individual lines would require transfer semantics and eventually route profitability. HPA-646 explicitly prefers city-level income and has no player-facing consumer for line attribution. A Bus → Metro journey should not earn twice merely because it transfers.

## Chosen tuning constant

Add one independent balance constant:

```rust
pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;
```

The amount is not derived from purchase prices or daily operating-cost constants.

Initial balance rationale:

- one Bus costs `$400 / day`; one worker completing an outbound and return transit journey contributes `$400 / day`, so one reliable commuter can offset one Bus-day;
- one Metro vehicle costs `$2,500 / day`; 13 completed transit journeys cover one train-day, so Metro still requires materially more ridership;
- the current Small Town template has two Small Houses with four residents each, so its eventual eight workers can generate up to 16 completed commute journeys per day. A well-used single-train Metro can therefore become sustainable, but an oversized multi-train service remains a real cost choice.

This is an initial tuning value, not a generic fare model. If playtesting later shows it is too high or low, change this constant directly.

## Exactly what earns income

A trip earns exactly `$200` when both are true:

1. its terminal status is `TripStatus::Arrived` or `TripStatus::Late`; and
2. its retained `RoutePlan` contains at least one leg whose mode is `TransitMode::Bus` or `TransitMode::Metro`.

Everything else earns zero:

- `Unserved` trip;
- walking-only completed trip;
- private-car completed trip;
- a malformed/planless terminal trip;
- any non-terminal trip.

A journey with multiple transit legs or transfers earns once total. Examples:

```text
Walk → Bus → Walk                    = $200
Walk → Metro → Walk                  = $200
Walk → Bus → Walk → Metro → Walk     = $200
Walk only                            = $0
Private car                          = $0
Unserved Bus/Metro attempt           = $0
```

Late journeys still earn income because the passenger completed the transit journey. Lateness remains visible through existing metrics; withholding the fare for a late arrival would add a second quality/pricing rule with no current product need.

## Settlement timing

Credit income immediately in the existing trip-resolution pass, not at midnight.

This avoids a persisted daily-revenue accumulator and keeps the rule tied to the exact event that justifies it. The tick engine already subdivides time around trip/vehicle boundaries, so immediate settlement remains deterministic across coarse and fine ticks.

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

This intentionally works from a negative budget. For example, `-100 + 200 = 100`, restoring capital-purchase eligibility as soon as enough useful ridership completes.

Creative remains budget-neutral. It does not need a new nominal-income field just to mirror Standard because there is no current UI consumer for projected/nominal transit revenue. HPA-645's nominal operating-cost display remains unchanged.

Do not route income through `CostPolicy`: that abstraction authorizes capital deductions, while HPA-646 is an unconditional positive settlement for a completed simulation outcome.

Do not add Campaign-specific behavior or tests. Campaign/growth is scheduled for deletion and new work should not preserve a second economy contract for it.

## Rust module boundary

Create one focused module:

`crates/caelum-core/src/transit_income.rs`

Its complete production surface is:

```rust
use crate::model::{ActiveTrip, EconomyPreset, GameSnapshot, TransitMode, TripStatus};

pub(crate) const TRANSIT_TRIP_INCOME: i32 = 200;

pub(crate) fn completed_transit_trip_income(trip: &ActiveTrip) -> i32;

pub(crate) fn apply_transit_income(state: &mut GameSnapshot, amount: i32);
```

`completed_transit_trip_income` owns only the qualification rule. It does not mutate state and does not know route objects, fleet size, operating cost, or line profitability.

`apply_transit_income` owns only preset-aware budget settlement:

- return for `amount <= 0`;
- return for Creative;
- Standard uses `saturating_add`.

Register the module as `pub(crate)` in `crates/caelum-core/src/lib.rs`.

Keep this separate from `operating_cost.rs`. Cost and income are currently two concrete rules with different triggering events; combining them into a generic economy manager, ledger, recurring rule trait, or transaction framework would add structure without a second consumer.

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

## No frontend, wire, or persistence expansion

HPA-646 does not need a frontend production change:

- `Topbar.svelte` already displays `state.budget` through `ShellTopbarState.budget`;
- the budget is already Rust-owned and host-neutral;
- `dailyOperatingCost` continues to show current nominal cost from HPA-645;
- there is no current requirement for daily income, profit, fare, or route-revenue text.

Do not add fields to `ServiceMetrics`, `Metrics`, `ShellTopbarState`, route rows, TypeScript domain types, or persistence just to expose the calculation separately.

No snapshot schema bump and no save migration. A save simply contains whatever budget the simulation has earned so far.

## Recovery behavior and intentional limits

The goal is a recovery path, not guaranteed profitability.

- A well-used transit service can generate positive cash flow and bring a negative Standard budget back above zero.
- A paused/broken route already stops generating HPA-645 actual operating cost; it also cannot successfully carry new riders, so it earns no new income.
- An oversized fleet can still lose money. This is desirable service-planning pressure rather than a defect in this slice.
- HPA-646 does not add vehicle withdrawal/sale/refunds. That remains a separate product decision if playtesting shows pause + ridership income is insufficient as a recovery loop.

## Determinism and duplicate-credit behavior

No new identity or settlement marker is needed.

A completed trip is terminal and is removed from `active_trips` during the same `advance_active_trips_with_zero_delta_ids` call in which income is credited. Re-advancing the returned snapshot therefore cannot encounter that trip and cannot credit it twice.

Save/restore needs no special handling: the budget already contains the credit and the completed trip is absent from the saved active-trip set.

A coarse tick and equivalent split ticks should finish with the same budget because the same trip-completion boundaries are already processed in both paths.

## Verification strategy

### Transit-income authority

Unit tests in `transit_income.rs` lock:

- Arrived Bus journey = `$200`;
- Late Metro journey = `$200`;
- Bus → Metro transfer journey = `$200` once;
- walking-only Arrived journey = `$0`;
- planless/private-car Arrived journey = `$0`;
- Unserved transit journey = `$0`;
- non-terminal transit journey = `$0`;
- Standard can recover from negative budget through positive settlement;
- Creative budget is unchanged;
- addition saturates rather than overflowing.

Use small `ActiveTrip`/`RoutePlan` fixtures local to the unit-test module. Do not create production fixture APIs.

### Trip-resolution wiring

Focused `trips.rs` tests should prove integration rather than rebuild a full network:

1. Start with a transit-qualifying active trip already at its destination and ready to resolve. One `advance_active_trips` call completes it, credits exactly `$200`, increments existing completion metrics, and removes it.
2. Advance the returned snapshot again; budget does not change because the terminal trip was removed.
3. Equivalent Creative completion changes trip/metrics state but not budget.
4. Equivalent walking-only completion increments completed trips but credits `$0`.
5. Two qualifying trips resolving in one pass credit `$400`, proving aggregation is additive without line attribution.

Existing route/vehicle integration tests already prove boarding, riding, alighting, and coarse/fine trip timing. Do not duplicate that matrix for this cash-flow rule.

### Regression gate

Run focused tests first, then the normal Rust workspace gate:

```bash
cargo test -p caelum-core transit_income
cargo test -p caelum-core trips::tests
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Because no TypeScript/Svelte production contract changes, frontend tests do not need new cases. Run the existing repository checks before final merge if the implementation workflow requires the full project gate.

## Non-goals

- per-line, per-route, per-mode, per-vehicle, or per-transfer revenue attribution;
- configurable fares or player fare controls;
- distance/time-based fares;
- passenger classes, fare zones, discounts, or dynamic pricing;
- route profit/loss or net operating-result metrics;
- daily revenue counters, accounting periods, ledgers, transaction history, charts, or finance dashboard;
- subsidies unrelated to completed ridership;
- taxation, loans, bonds, debt servicing, bankruptcy, or game-over rules;
- fleet sale, withdrawal, reassignment, refund, or automatic optimization;
- a generic economy engine/framework/trait/registry;
- scheduler or additional tick boundaries;
- schema migration, compatibility adapter, or feature flag.
