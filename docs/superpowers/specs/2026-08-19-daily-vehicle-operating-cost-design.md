# HPA-645 Daily Vehicle Operating Cost Design

**Linear:** HPA-645  
**Parent:** HPA-335  
**Related:** HPA-643, HPA-628

## Goal

Complete the smallest Phase 5 financial-feedback slice after HPA-643:

> Show the recurring daily cost implied by a Bus/Metro service plan, then make Standard sandbox pay that cost once per game day while Creative displays the same nominal cost without reducing budget.

The financial signal must change a real service-planning choice without turning Caelum into an accounting game. A tighter target can require a larger fleet and therefore a larger projected daily cost before deployment; after deployment, adding or pausing service changes the daily cost the player sees.

Do not add fares, subsidies, revenue attribution, ledgers, history, proration, refunds, a finance screen, or a generic recurring-cost framework.

## Verified baseline and reuse

Current `main` already has the required seams:

- `crates/caelum-core/src/transit.rs` owns the current nominal purchase costs: `BUS_COST = 8_000` and `METRO_COST = 50_000`.
- `crates/caelum-core/src/service_control.rs` owns the shared Bus/Metro runtime-only `ServiceMetrics` projection used by the Lines row.
- `GameEngine::snapshot()` derives `ServiceMetrics` on an output clone; incoming service metrics are ignored and save normalization clears them.
- `crates/caelum-core/src/trips.rs::next_boundary_after` already inserts the next exact midnight boundary as `(day + 1) * GAME_DAY_SECONDS`.
- Paused ticks already return without advancing game time, so global pause cannot cross a day boundary.
- `GameSnapshot.budget` is canonical persisted state and is already visible in the top bar.
- `EconomyPreset` already distinguishes Standard and Creative.
- `CostPolicy::quote` / `AuthorizedCost::apply_to` intentionally reject unaffordable capital purchases and therefore are the wrong path for a recurring debit that must be allowed to take Standard below zero.
- Persistence validates time/rules but does not require `budget >= 0`; negative Standard budget is already representable.
- `LinesPanel.svelte` already has separate zero-fleet and deployed service blocks and already uses `formatBudget`.

HPA-645 extends these seams rather than introducing a second economy model.

## Chosen product rule

Use explicit daily tuning constants:

```rust
pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;
```

These happen to be 5% of today's purchase prices, but they are independent balance controls. Do not implement them as `0.05 * BUS_COST` / `METRO_COST`; changing purchase price must not silently retune recurring expense.

A fleet's nominal daily cost is:

```text
vehicle count × mode daily operating cost
```

Use saturating integer arithmetic at this numeric boundary. `TransitMode::Walk` defensively maps to zero.

## Capital cost and recurring cost are different contracts

Do **not** route daily operating cost through `CostPolicy`.

`CostPolicy` exists to quote and authorize player purchases before mutation. Standard purchase authorization rejects when budget is insufficient and `AuthorizedCost::apply_to` refuses a deduction below zero. HPA-645 explicitly requires the opposite recurring-expense behavior:

```text
budget before midnight: $399
one running Bus:        $400/day
budget after midnight:  -$1
```

Therefore a narrow recurring deduction path is correct and not duplication. Existing construction, deployment, and top-up affordability behavior stays unchanged.

## Chargeability: route active + connected + assigned fleet

A deployed line is chargeable at a day boundary only when all are true:

```text
route.active
AND every route leg is Connected
AND assigned fleet > 0
```

Reuse `route_lifecycle::is_route_operational(route.active, legs)` rather than duplicating route-state logic.

Consequences:

- `SetRouteActive { active: false }` makes the next daily charge zero;
- a broken line is not charged;
- a zero-fleet line is not charged;
- global simulation pause is **not** a route chargeability input.

Global pause only freezes time. A globally paused but still-active line continues to display its nominal daily operating cost because it remains the cost the service will incur at the next midnight once time resumes. No charge occurs while globally paused because no day boundary is crossed.

This distinction is load-bearing: HPA-628 currently folds `route.active && !snapshot.paused` before calculating its top-up offer. HPA-645 must split those inputs so `nextVehicleCost` remains suppressed by global pause while `dailyOperatingCost` uses route-active state only.

## Day-boundary semantics: one charge per observed boundary

Create one focused function:

```rust
pub(crate) fn apply_day_boundary_charge(
    state: &mut GameSnapshot,
    previous_day: u32,
)
```

It returns immediately when:

- `state.rules.game_mode != GameMode::Sandbox`;
- `state.day <= previous_day`;
- `state.rules.economy_preset == EconomyPreset::Creative`;
- the current chargeable assigned-fleet cost is zero.

For Standard, subtract the current chargeable fleet cost **once**:

```rust
state.budget = state.budget.saturating_sub(total_daily_cost);
```

Do not multiply by `state.day - previous_day` and do not add a `crossed_days` concept. Normal engine progression cannot skip multiple midnights because `next_boundary_after` inserts each next day boundary. If a future change ever jumps several days in one substep, that is a tick-boundary correctness bug; charging today's fleet repeatedly would not reconstruct historical state at the skipped boundaries.

This is fixed boundary billing, not active-time accounting. State at each actual midnight decides the charge. There is no proration, refund, accrued balance, or `lastChargedDay`.

## Tick integration: reuse the existing midnight substep

Do not add an economy scheduler.

In `trips::advance_tick_substep`, capture the previous day, advance time, synchronize the clock, then apply the boundary charge:

```rust
let previous_day = state.day;
let mut next = state.clone();
next.time += delta_seconds;
sync_clock(&mut next);
crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
reset_daily_commute_flags(&mut next);
```

`next_boundary_after` already guarantees a substep ending at midnight, so a coarse tick and equivalent split ticks see the same charge boundaries.

A save made after midnight already contains the deducted budget and new day/time. Restoring it and ticking within that same day has `previous_day == state.day`, so the boundary cannot be charged again. No persisted settlement marker or schema bump is needed.

## Focused Rust authority

Create `crates/caelum-core/src/operating_cost.rs` and register it as `pub(crate)` in `lib.rs`.

Public-within-crate surface:

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

`projected_line_daily_operating_cost` owns the one UI-facing projection rule:

- zero assigned fleet + `required_fleet: Some(n)` => projected `n × mode cost`;
- zero assigned fleet + no requirement => zero;
- assigned fleet => assigned-fleet cost only while `is_route_operational(active, legs)` is true;
- inactive/broken assigned fleet => zero.

The actual boundary charge uses only assigned operational fleets. It must never charge a zero-fleet service's projected required fleet.

Do not add `RecurringExpense`, `EconomyService`, a ledger entry, trait, registry, event bus, or generalized scheduler.

## `ServiceMetrics.dailyOperatingCost`

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

The value is nominal and identical in Standard and Creative. Economy preset affects deduction only; TypeScript must not inspect the preset to recalculate or zero the metric.

### Keep route pause and global pause separate

Change `service_control::metrics` to receive both route activity and global pause rather than the currently folded `active && !snapshot.paused` value:

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

Then:

```rust
let next_vehicle_cost = top_up_offer(
    active && !globally_paused,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);

let daily_operating_cost = operating_cost::projected_line_daily_operating_cost(
    active,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);
```

`populate_snapshot_metrics` passes `route.active` / `line.active` and `snapshot.paused` separately. This preserves HPA-628 while preventing global pause from making the nominal daily cost disappear.

Keep `ServiceMetrics` runtime-only:

- no serde default for `daily_operating_cost`;
- no compatibility alias;
- no persisted field;
- incoming `serviceMetrics` remains ignored;
- `snapshot_for_save()` still omits service metrics;
- no snapshot schema bump.

## UI projection and copy

Add required `dailyOperatingCost` to:

- `src/domain/types.ts::ServiceMetrics`;
- `src/runtime/types.ts::ShellServiceState`.

`runtimeSelectors.ts` forwards Rust only:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
```

No TypeScript operating-cost constants or fleet multiplication.

### Zero-fleet block

When Rust has a real required fleet, show:

```text
Est. daily cost  $1,200
```

Do not render an estimate row before a target/required fleet exists.

### Deployed block

Show:

```text
Daily cost  $1,200
```

A route-level pause or broken service yields `$0`. Global simulation pause keeps the nominal value because `dailyOperatingCost` remains route-state based.

Use existing `formatBudget`; no new formatter or finance surface.

## Creative semantics

Creative displays exactly the same nominal `dailyOperatingCost` as Standard for the same route/fleet state. Only the canonical budget deduction differs.

This needs a direct regression. A Creative public-engine test must assert both:

- budget is unchanged across midnight;
- `daily_operating_cost` remains the same nominal Bus value as Standard (400 for the one-bus fixture).

Do not publish Creative-specific zero cost and do not add a frontend `deductsOperatingCost` flag.

## Verification strategy

### Pure Rust authority

Unit tests in `operating_cost.rs` lock:

- Bus = 400/vehicle/day;
- Metro = 2,500/vehicle/day;
- saturating fleet multiplication;
- zero-fleet/no-required projection = zero;
- zero-fleet with required fleet = projected required-fleet cost;
- active connected assigned fleet = assigned-fleet cost;
- inactive/broken assigned fleet = zero;
- Standard day transition deducts once and can cross below zero;
- Creative day transition does not deduct;
- Campaign is unchanged;
- no day transition does not deduct.

No `crossed_days` unit or multi-day multiplier test is added.

### Public tick / determinism

Reuse existing `crates/caelum-core/tests/service_control.rs` fixtures.

Lock:

1. Standard one-bus fixture: set budget to 399, cross midnight, assert `-1` and sandbox remains running.
2. Creative equivalent: cross midnight, assert budget unchanged **and** output `daily_operating_cost == 400`.
3. Coarse tick crossing midnight vs equivalent split ticks: assert `time`, `day`, and `budget` match.
4. Save/restore after the charged boundary: small same-day tick does not charge again.
5. Route pause: `SetRouteActive { active: false }` publishes daily cost zero and avoids the next boundary charge.
6. Broken service: no daily charge.
7. Global pause invariant: on a deployed Bus, `SetPaused { paused: true }` keeps `daily_operating_cost == 400 × assigned_fleet`; on a shortfall fixture, `next_vehicle_cost` remains suppressed while globally paused.

No Playwright midnight scenario is required; Rust owns settlement timing.

### Wire and frontend

Update direct non-null `ServiceMetrics` fixtures and the exact camelCase wire object with `dailyOperatingCost`.

Frontend tests lock:

- selector forwards Rust's value;
- zero-fleet target renders `Est. daily cost`;
- deployed service renders `Daily cost`;
- route-paused/broken value renders as `$0` from Rust projection;
- Metro uses the same component path.

No frontend formula or preset branch is permitted.

## Risks and bounded decisions

### Boundary gaming is accepted

A route resumed just after midnight does not pay until the next midnight; pausing just before midnight avoids that day's charge. Fixing this requires proration/history and is intentionally outside HPA-645.

### Broken routes are free while broken

This uses the existing operational predicate. Charging parked/broken assets would be a separate ownership/maintenance rule.

### Daily values are independent tuning constants

400 / 2,500 are intentionally explicit. Retuning purchase prices does not automatically retune operating cost.

### No revenue yet

Expense-only feedback is sufficient to make fleet/headway scale financially visible. Add fares/subsidies only if later play evidence requires a net operating result.

## Non-goals

- fares, subsidies, ticket revenue, transfers/revenue attribution, or net profit;
- per-distance, per-hour, occupancy, congestion, vehicle-age, fuel, energy, staffing, or maintenance models;
- active-time history, proration, refunds, partial-day settlement, transaction logs, or accounting periods;
- a multi-day catch-up multiplier or skipped-boundary settlement rule;
- budgets by department, cost centres, ledgers, loans, bonds, taxes, bankruptcy, or game-over rules;
- a finance/dashboard/history UI or global cost chart;
- target editing after deployment, fleet withdrawal/sale/reassignment/refund, holding, or optimization;
- a generic recurring-expense system, dependency, feature flag, schema migration, or backward-compatibility adapter;
- changes to capital purchase affordability or `CostPolicy`.