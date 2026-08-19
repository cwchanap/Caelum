# HPA-645 Daily Vehicle Operating Cost Design

**Linear:** HPA-645  
**Parent:** HPA-335  
**Related:** HPA-643, HPA-628

## Goal

Complete the smallest Phase 5 financial-feedback slice after HPA-643:

> Show the recurring daily cost implied by a Bus/Metro service plan, then make Standard sandbox actually pay that cost once per game day while Creative displays the same nominal cost without reducing budget.

The financial signal must change a real service-planning choice without turning Caelum into an accounting game. A tighter target can require a larger fleet and therefore a larger projected daily cost before deployment; after deployment, adding or pausing service changes the daily cost the player sees.

Do not add fares, subsidies, revenue attribution, ledgers, history, proration, refunds, a finance screen, or a generic recurring-cost framework.

## Verified baseline and reuse

Current `main` already has the required seams:

- `crates/caelum-core/src/transit.rs` owns the current nominal vehicle purchase costs: `BUS_COST = 8_000` and `METRO_COST = 50_000`.
- `crates/caelum-core/src/service_control.rs` owns shared Bus/Metro cycle time, required fleet, initial deployment estimate, top-up offer, nominal headway, and the runtime-only `ServiceMetrics` projection used by the Lines row.
- `GameEngine::snapshot()` derives `ServiceMetrics` only on an output clone; incoming service metrics are ignored and save normalization clears them.
- `crates/caelum-core/src/trips.rs` already splits coarse ticks at the next exact game-day boundary through `next_boundary_after`, then advances a substep and synchronizes `snapshot.day` from `snapshot.time`.
- `GameSnapshot.budget` is already canonical persisted state and the top bar already renders it.
- `EconomyPreset` already distinguishes Standard and Creative. Existing `CostPolicy::quote` / `AuthorizedCost::apply_to` intentionally reject unaffordable capital purchases and therefore are the wrong authorization path for a recurring cost that must be allowed to take Standard below zero.
- Persistence currently does not require `budget >= 0`, so a negative live budget does not need a schema or persistence-rule change.
- `LinesPanel.svelte` already has separate zero-fleet and deployed service blocks, which gives the cost one natural row in each state.

HPA-645 should extend these seams rather than introduce a second economy model.

## Approaches considered

### A. Fixed daily vehicle cost + day-boundary deduction — chosen

Give each mode one fixed daily vehicle cost, project it through `ServiceMetrics`, and charge the active connected fleet at the existing game-day boundary. Standard deducts; Creative does not.

This is the smallest slice that satisfies all Phase 5 evidence:

- the player sees recurring cost before committing to a headway/fleet;
- the value changes when fleet size or route-active state changes;
- Standard budget actually responds;
- Creative stays budget-neutral;
- no revenue system is needed to make the signal understandable.

### B. Projection only — rejected

Showing a daily cost without changing Standard budget is cheaper, but HPA-335 explicitly requires Standard to deduct the financial signal and allows Standard to become negative. Projection-only work would not complete the parent slice.

### C. Add fares/subsidy and show net operating result — rejected for now

A fare/subsidy rule would immediately require decisions about trip attribution, settlement timing, transfers, incomplete/unserved trips, and potentially per-line revenue ownership. None of that is required to make fleet operating cost affect a service decision. Add revenue later only if play evidence shows expense-only feedback is insufficient.

## Product rule: one fixed daily cost per running vehicle

Use explicit mode tuning constants:

```rust
pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;
```

The initial values are exactly 5% of the current nominal vehicle purchase prices, but the implementation keeps them as explicit constants rather than adding a configurable percentage/rate system. They are game-balance values, not accounting formulae.

A fleet's nominal daily cost is:

```text
assigned_or_planned_vehicle_count × mode_daily_operating_cost
```

Use saturating integer arithmetic at this boundary. A pathological forged fleet count must not panic or wrap the budget; it may saturate at `i32::MAX`.

`TransitMode::Walk` has no vehicle operating cost and returns zero from the helper defensively.

## Chargeability: active + connected + assigned

A deployed line is chargeable at a day boundary only when all of these are true:

```text
route.active
AND every route leg is Connected
AND assigned fleet > 0
```

Reuse `route_lifecycle::is_route_operational(route.active, legs)` for the first two conditions. Do not duplicate route-health/status logic in a finance module.

Consequences:

- a player can pause a line to make its next daily operating charge zero;
- a broken service is not charged while its vehicles are parked/unusable;
- a zero-fleet line is never charged;
- global simulation pause needs no accounting flag because paused ticks do not advance game time or cross a day boundary.

This slice deliberately does not accumulate active seconds. State at the game-day boundary decides whether the next daily charge applies. There is no proration, refund, partial-day charge, or `lastChargedDay` history.

## Day-boundary semantics

Add one narrow function in a focused module:

```rust
pub(crate) fn apply_day_boundary_charge(
    state: &mut GameSnapshot,
    previous_day: u32,
)
```

The function returns immediately when:

- `state.rules.game_mode != GameMode::Sandbox`;
- `state.day <= previous_day`;
- the economy preset is Creative;
- the live chargeable fleet cost is zero.

For Standard, compute the current chargeable daily fleet cost and subtract it once per crossed game day. Normal engine progression crosses exactly one day at a time because `next_boundary_after` already includes the next midnight. Multiplying by `state.day - previous_day` keeps the helper safe for a direct multi-day call without introducing another scheduler.

Budget subtraction uses saturating arithmetic and **does not** perform affordability authorization:

```rust
state.budget = state.budget.saturating_sub(total_charge);
```

That distinction is intentional:

- capital construction and vehicle purchases keep the existing `CostPolicy::quote(...).authorize()` behavior and cannot make Standard negative;
- recurring operating expense may make Standard negative;
- negative budget does not end Sandbox or mutate `metrics.state`.

Do not change `CostQuote`, `AuthorizedCost`, or paid player-intent behavior for HPA-645.

## Tick integration: reuse the existing midnight boundary

Do not add an economy scheduler.

In `trips::advance_tick_substep`, capture the previous day, advance time, synchronize the clock, and then apply the charge:

```rust
let previous_day = state.day;
let mut next = state.clone();
next.time += delta_seconds;
sync_clock(&mut next);
crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
reset_daily_commute_flags(&mut next);
```

The existing `next_boundary_after` already guarantees a substep at midnight, so this preserves coarse/fine tick determinism without a persisted charge marker.

The charge runs before vehicle/trip advancement for the new day. Budget does not currently affect trip routing or movement, so no simulation ordering dependency is introduced.

A save made exactly after midnight already contains the deducted budget and the new day/time. On restore, the next tick starts with `previous_day == state.day`, so the same boundary cannot be charged twice. No `lastChargedDay` field or schema bump is justified.

## Focused Rust module

Create `crates/caelum-core/src/operating_cost.rs` and register it as `pub(crate)` in `lib.rs`.

Keep exactly these responsibilities together:

```rust
pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;

pub(crate) fn vehicle_daily_operating_cost(mode: TransitMode) -> i32;
pub(crate) fn fleet_daily_operating_cost(mode: TransitMode, fleet: usize) -> i32;
pub(crate) fn projected_line_daily_operating_cost(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> i32;
pub(crate) fn apply_day_boundary_charge(state: &mut GameSnapshot, previous_day: u32);
```

`projected_line_daily_operating_cost` has one UI-facing rule:

- when `assigned_fleet == 0`, return the required fleet's nominal daily cost when `required_fleet` exists, otherwise zero;
- when a fleet is assigned, return its cost only while `is_route_operational(active, legs)` is true, otherwise zero.

This gives a pre-deployment estimate and a post-deployment current charge using one field and one Rust formula.

Do not make a generic `RecurringExpense`, `EconomyService`, ledger entry, trait, registry, or event bus.

## Chosen `ServiceMetrics` contract

Extend runtime-derived `ServiceMetrics` with exactly one required field:

```rust
pub daily_operating_cost: i32,
```

Wire form:

```ts
interface ServiceMetrics {
  // existing fields...
  dailyOperatingCost: number;
}
```

The value is nominal and identical in Standard and Creative. Creative changes the deduction rule, not the projection. TypeScript must not inspect `economyPreset` to recalculate or zero the metric.

In `service_control::metrics`:

1. derive `round_trip_seconds` and `required_fleet` as today;
2. compute deployment/top-up/headway values as today;
3. call `operating_cost::projected_line_daily_operating_cost(...)` once;
4. publish the result with the existing health fields.

Keep `ServiceMetrics` runtime-only:

- no serde default for the new field;
- no compatibility alias;
- no new persisted field;
- incoming `serviceMetrics` remains ignored;
- `snapshot_for_save()` still omits it.

No snapshot schema bump is required.

## UI projection and copy

Add required `dailyOperatingCost` to:

- `src/domain/types.ts::ServiceMetrics`;
- `src/runtime/types.ts::ShellServiceState`.

`runtimeSelectors.ts` forwards only Rust's value:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
```

Do not duplicate mode constants, fleet multiplication, active/broken predicates, or Standard/Creative behavior in TypeScript.

### Zero-fleet service block

When `requiredFleet !== null`, show:

```text
Est. daily cost  $1,200
```

beside the existing Required / Est. deploy cost rows. The same row immediately reflects a changed target because Rust recomputes `requiredFleet` and `dailyOperatingCost`.

Do not render an `Est. daily cost $0` row before a target produces a required fleet.

### Deployed service block

Always show:

```text
Daily cost  $1,200
```

for the current Rust projection. A route pause produces `$0`; resuming restores the fleet cost. A broken service also falls back to zero because derived service metrics are unavailable/currently non-chargeable.

Use existing `formatBudget`; do not add a second currency formatter.

No new finance panel, modal, tooltip, warning, toast, chart, or global daily-cost aggregate is part of this slice. The existing top-bar budget provides the visible result when midnight applies the Standard charge.

## Creative semantics

Creative must display the same nominal `dailyOperatingCost` values as Standard so service planning still communicates scale.

At the day boundary, Creative's canonical `budget` remains unchanged. Do not publish a Creative-specific zero cost and do not add a `deductsOperatingCost` UI flag. The preset already defines Creative as budget-neutral; the projection describes the nominal service cost.

## Negative Standard budget

Standard recurring cost may cross below zero:

```text
budget before midnight: $399
one running Bus:        $400/day
budget after midnight:  -$1
```

This does not lose the sandbox, pause the game, remove service, or create a rejection. Existing paid player actions naturally remain unaffordable while the budget is insufficient because their existing authorization paths are unchanged.

No overdraft floor, bankruptcy state, loan, emergency subsidy, or negative-budget warning is added.

## Verification strategy

### Pure operating-cost authority

Unit tests in `operating_cost.rs` lock:

- Bus cost is 400 per vehicle;
- Metro cost is 2,500 per vehicle;
- fleet multiplication uses the shared helper;
- zero-fleet/no-target projection is zero;
- zero-fleet with a required fleet publishes the projected required-fleet cost;
- active connected assigned fleet publishes the assigned-fleet cost;
- inactive/broken assigned fleet publishes zero;
- Standard boundary charge subtracts and can cross below zero;
- Creative boundary charge leaves budget unchanged;
- campaign mode is unchanged;
- no day transition is unchanged.

### Tick integration and determinism

Reuse the existing transit fixture in `crates/caelum-core/tests/service_control.rs` rather than building a second route harness.

Lock one deployed Bus through the public `GameEngine`:

- set a target that requires one bus;
- deploy;
- set budget to 399 via the existing test seam;
- resume simulation;
- tick to the next day boundary;
- assert budget is -1 and sandbox remains running.

Then compare one coarse tick crossing midnight with equivalent split ticks and assert at least `time`, `day`, and `budget` match. This proves the charge is attached to the existing boundary rather than raw host tick cadence.

Use the same fixture converted/restored with `EconomyPreset::Creative` to prove the public tick path leaves budget unchanged.

Add a save/restore assertion at the charged boundary: restore the saved day-1 snapshot, resume, tick a small sub-day delta, and prove there is no duplicate charge.

### Service output / wire

In existing service-control tests:

- zero-fleet Bus target publishes required-fleet projected daily cost;
- deployed Bus publishes assigned-fleet daily cost;
- paused Bus publishes zero;
- one Metro assertion proves the shared mode path and 2,500-per-train rule;
- forged incoming `serviceMetrics` remains non-authoritative;
- `snapshot_for_save()` still omits service metrics.

Update every direct Rust `ServiceMetrics { ... }` literal and the exact camelCase `serviceMetrics` JSON expectation in `crates/caelum-core/tests/model_wire_format.rs` with `dailyOperatingCost`.

### TypeScript / Svelte

Update the existing required-field fixtures that already construct non-null service metrics/shell service state:

- `tests/runtime/runtimeSelectors.test.ts`;
- `tests/runtime/snapshotView.test.ts`;
- `tests/runtime/gameRuntime.test.ts`;
- `tests/ui/appShell.test.ts`;
- `tests/ui/linesPanel.test.ts`.

Lock in `linesPanel.test.ts`:

- zero-fleet targeted Bus shows the Rust-quoted `Est. daily cost`;
- deployed Bus shows `Daily cost`;
- paused deployed Bus shows `$0` rather than reproducing a rule in Svelte;
- Metro displays the Rust-provided value through the same component.

No new Playwright scenario is required solely to wait for midnight. Rust owns the tick/deduction contract, and the existing UI/runtime tests can lock projection/rendering without a slow end-to-end day simulation.

## Risks and bounded decisions

### Boundary billing is intentionally not prorated

A route resumed just after midnight will not pay until the next day boundary; a route paused before the boundary avoids the next charge. Fixing that would require active-time accumulation or a persisted settlement marker, which is explicitly outside this evidence-backed slice. If play makes boundary gaming material, treat proration as a separate task.

### Broken routes are free while broken

This matches the current operational predicate and avoids charging vehicles that cannot run. Do not invent maintenance/ownership cost to keep charging parked fleets; that would be a second economic rule.

### Daily cost values are tuning constants

The 400 / 2,500 values intentionally track 5% of today's purchase prices but are not dynamically derived. If vehicle purchase prices are retuned later, decide explicitly whether operating costs should also move rather than coupling two balance controls accidentally.

### No revenue yet

Expense-only feedback is enough to make headway/fleet scale financially visible. Fare/subsidy work should be added only if gameplay evidence shows players cannot make useful decisions without a net result.

## Non-goals

- fares, subsidies, ticket revenue, transfers/revenue attribution, or net profit;
- per-distance, per-hour, occupancy, congestion, vehicle-age, fuel, energy, staffing, or maintenance models;
- active-time history, proration, refunds, partial-day settlement, transaction logs, or accounting periods;
- budgets by department, cost centres, ledgers, loans, bonds, taxes, bankruptcy, or game-over rules;
- a finance/dashboard/history UI or global cost chart;
- target editing after deployment, fleet withdrawal/sale/reassignment/refund, holding, or optimization;
- a generic recurring-expense system, plugin architecture, dependency, feature flag, schema migration, or backward-compatibility adapter.