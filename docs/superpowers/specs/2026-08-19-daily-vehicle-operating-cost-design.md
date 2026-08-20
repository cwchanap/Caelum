# HPA-645 Daily Vehicle Operating Cost Design

**Linear:** HPA-645  
**Parent:** HPA-335  
**Related:** HPA-643, HPA-628, HPA-646

## Goal

Complete the smallest Phase 5 recurring-cost slice after HPA-643:

> Show both the real daily cost of deployed Bus/Metro fleets and the hypothetical daily cost of a not-yet-deployed service plan, make Standard pay the real deployed cost once per game day, and keep Creative budget-neutral while showing the same nominal values.

Keep the implementation narrow: one Rust operating-cost authority, the existing midnight substep, two runtime-only service-metric fields, one Lines-row value per service state, and one city-wide topbar readout. Do not add a scheduler, ledger, revenue attribution, finance screen, migration, or compatibility layer.

## Verified baseline and reuse

Current `main` already provides the needed seams:

- `crates/caelum-core/src/transit.rs` owns the capital vehicle prices (`BUS_COST = 8_000`, `METRO_COST = 50_000`). HPA-645 must not derive recurring cost from them.
- `crates/caelum-core/src/service_control.rs` owns the shared Bus/Metro runtime-only `ServiceMetrics` projection.
- `GameEngine::snapshot()` publishes service metrics only on an output clone; route/Metro input ignores `service_metrics`, and persistence normalization removes it. Adding runtime-only service fields needs no schema bump.
- `crates/caelum-core/src/trips.rs::next_boundary_after` always inserts the next exact day boundary, and both normal and cap-exhaustion tick paths use that boundary.
- `trips::advance_tick_substep` is the one place that advances `time`, calls `sync_clock`, and then continues per-day work on the local candidate snapshot.
- Paused ticks do not advance time, so a globally paused game cannot cross midnight.
- `GameSnapshot.budget` is already canonical persisted state and may represent a negative value.
- `EconomyPreset` already distinguishes Standard and Creative.
- `CostPolicy::quote` / `AuthorizedCost::apply_to` are capital-purchase authorization: they reject unaffordable Standard purchases and cannot perform the below-zero recurring debit required here.
- `LinesPanel.svelte` already has separate zero-fleet and deployed service blocks and already uses `formatBudget`.
- `ShellTopbarState` / `Topbar.svelte` already expose compact city-wide readouts.
- `CLAUDE.md` marks Campaign/growth as scheduled for deletion and says new work must not extend or preserve those invariants.

## Chosen tuning constants

Use independent explicit values:

```rust
pub(crate) const BUS_DAILY_OPERATING_COST: i32 = 400;
pub(crate) const METRO_DAILY_OPERATING_COST: i32 = 2_500;
```

These happen to equal 5% of today's purchase prices, but that relationship is documentation only. Do not implement `0.05 * BUS_COST` or `0.05 * METRO_COST`; purchase price and daily operating cost are separate balance controls.

`TransitMode::Walk` defensively maps to zero.

Fleet multiplication uses saturating integer arithmetic so a forged pathological count cannot wrap.

## One actual-cost rule

There must be one implementation of “what does this deployed line cost per day”:

```rust
pub(crate) fn line_daily_operating_cost(
    route_active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
) -> i32;
```

It returns zero unless all of these are true:

```text
assigned_fleet > 0
AND legs is non-empty
AND route is active
AND every leg is Connected
AND every leg has a current_path
```

Use `route_lifecycle::is_route_operational(route_active, legs)` for the active/connected rule and add the non-empty/current-path guards locally. Do not change `is_route_operational` globally merely to serve this feature.

If chargeable, return:

```text
assigned_fleet × mode daily operating cost
```

Both service projection and billing consume this helper. Do not add a second `chargeable_daily_cost` implementation that re-derives the same predicate.

A city total is just the sum of this same rule across Bus routes and Metro lines:

```rust
pub(crate) fn city_daily_operating_cost(state: &GameSnapshot) -> i32;
```

The sum uses saturating addition.

## Keep actual and estimated cost separate

One field must not mean both “money currently due” and “hypothetical cost if you deploy.” Existing service metrics already distinguish those semantics (`estimatedDeploymentCost` vs deployed offers), and HPA-645 follows the same convention.

Add exactly two runtime-only fields:

```rust
pub daily_operating_cost: i32,
pub estimated_daily_operating_cost: Option<i32>,
```

Wire form:

```ts
interface ServiceMetrics {
  // existing fields...
  dailyOperatingCost: number;
  estimatedDailyOperatingCost: number | null;
}
```

Semantics:

- `dailyOperatingCost` is **actual current deployed liability only**. It is zero for zero fleet, inactive route, broken route, or an unusable/empty leg set.
- `estimatedDailyOperatingCost` is **hypothetical pre-deployment cost only**. It is `Some(requiredFleet × mode cost)` only while `assignedFleet == 0` and `requiredFleet` is known; otherwise it is `None`.

Use a narrow estimator:

```rust
pub(crate) fn estimated_line_daily_operating_cost(
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32>;
```

This split makes `sum(dailyOperatingCost)` a correct city-wide current burn by construction; hypothetical zero-fleet estimates can never leak into the total.

## Route pause and global pause are different inputs

HPA-628 currently passes `route.active && !snapshot.paused` into `metrics(...)` because global pause suppresses `nextVehicleCost`. HPA-645 must not reuse that folded flag for daily liability.

Make the signature explicit:

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
) -> Option<ServiceMetrics>;
```

At the call site, use named locals before the positional call:

```rust
let route_active = route.active;
let globally_paused = snapshot.paused;
```

Then preserve the two contracts separately:

```rust
let next_vehicle_cost = top_up_offer(
    route_active && !globally_paused,
    legs,
    mode,
    assigned_fleet,
    required_fleet,
);

let daily_operating_cost = operating_cost::line_daily_operating_cost(
    route_active,
    legs,
    mode,
    assigned_fleet,
);
```

Global simulation pause therefore freezes time and suppresses HPA-628 top-up, but an otherwise active deployed line still displays its nominal daily liability. Route pause (`SetRouteActive { active: false }`) makes actual daily liability zero.

## Day-boundary settlement

Create one narrow mutation helper:

```rust
pub(crate) fn apply_day_boundary_charge(
    state: &mut GameSnapshot,
    previous_day: u32,
);
```

It returns when:

- `state.day <= previous_day`;
- the economy preset is Creative;
- `city_daily_operating_cost(state) == 0`.

For Standard, subtract the current city daily cost exactly once:

```rust
state.budget = state.budget.saturating_sub(total_daily_cost);
```

Do **not** use `CostPolicy::quote`, `authorize`, or `apply_to`: recurring expense is allowed to cross below zero while capital purchases must remain affordability-gated.

Also do not import `CostPolicy` solely to avoid a trivial preset match. `operating_cost` owns settlement; matching `EconomyPreset::Creative` directly keeps it independent of the capital-authorization module and avoids sharing a type whose reason to change is different.

Do not add a Campaign/GameMode guard or a Campaign regression. Campaign/growth is scheduled for deletion; HPA-645 adds no Campaign-specific semantics. Dormant code simply inherits the economy preset behavior until it is removed.

## Reuse the existing midnight boundary

Integrate settlement in `trips::advance_tick_substep` immediately after `sync_clock`:

```rust
let previous_day = state.day;
let mut next = state.clone();
next.time += delta_seconds;
sync_clock(&mut next);
crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
reset_daily_commute_flags(&mut next);
```

Do not move the charge into `on_substep` or add another scheduler/timer.

Do not add `crossed_days` or multiply by `state.day - previous_day`. The existing tick machinery cannot legitimately skip a midnight. If it ever does, that is a tick-boundary correctness bug; billing the current fleet repeatedly cannot reconstruct historical fleet state at skipped boundaries.

A save immediately after midnight already contains the deducted budget and new day/time. Restoring it and advancing within the same day has `previous_day == state.day`, so the boundary cannot be charged twice. No `lastChargedDay` field is needed.

## Rust module boundary

Create `crates/caelum-core/src/operating_cost.rs`, registered as `pub(crate)` in `lib.rs`.

Its complete current surface is:

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

No trait, manager, recurring-expense framework, ledger entry, registry, event bus, or scheduler.

## Runtime-only wire contract

The two new `ServiceMetrics` fields are required when `serviceMetrics` is present:

```rust
pub daily_operating_cost: i32,
pub estimated_daily_operating_cost: Option<i32>,
```

No serde defaults are added to suppress fixture fallout. Update direct Rust literals and exact camelCase JSON expectations.

The existing route/Metro `service_metrics` container remains `skip_deserializing` / omitted from saves. `snapshot_for_save()` still removes it. No snapshot schema bump.

## TypeScript is projection only

Add the two fields to `src/domain/types.ts::ServiceMetrics` and `src/runtime/types.ts::ShellServiceState`.

`selectServiceState` only forwards:

```ts
dailyOperatingCost: route.serviceMetrics?.dailyOperatingCost ?? 0,
estimatedDailyOperatingCost:
  route.serviceMetrics?.estimatedDailyOperatingCost ?? null,
```

No TypeScript mode constant, fleet multiplication, route-chargeability predicate, or economy-preset branch.

## Lines UI

The existing separate blocks consume separate semantics.

Zero-fleet block:

```text
Est. daily cost  $1,200
```

Render only when `estimatedDailyOperatingCost !== null`.

Deployed block:

```text
Daily cost  $1,200
```

Always render the actual `dailyOperatingCost` supplied by Rust. Route pause/breakage produces `$0`; global simulation pause leaves the active line's nominal liability visible.

Use existing `formatBudget`.

## City-wide daily burn in the Topbar

Now that `dailyOperatingCost` has one unambiguous meaning, expose one compact city-wide readout:

```text
Daily cost  $2,900
```

Add `dailyOperatingCost: string` to `ShellTopbarState` and one `Topbar.svelte` readout.

In `runtimeSelectors.ts`, sum only already-published actual fields across Bus and Metro:

```ts
const dailyOperatingCost = [
  ...state.transit.routes,
  ...state.transit.metroLines,
].reduce(
  (total, line) => total + (line.serviceMetrics?.dailyOperatingCost ?? 0),
  0,
);
```

Then format it with existing `formatBudget`.

This is presentation aggregation, not a second gameplay formula: TypeScript does not know 400/2,500, fleet counts, route status, or preset behavior. Hypothetical `estimatedDailyOperatingCost` is never included.

Do not add a finance panel, chart, history, toast, or transaction log.

## Creative semantics

For identical service state, Standard and Creative publish identical actual and estimated nominal costs. Only the midnight budget mutation differs.

A Creative public-engine regression must prove both:

- budget is unchanged across midnight;
- a one-Bus deployed service still publishes `daily_operating_cost == 400`.

## Primary product risk: Standard can become permanently unbuildable

HPA-645 intentionally introduces a one-way expense before positive cash flow exists.

In release gameplay:

- `SetBudget` is debug-only;
- there is no fare/subsidy income;
- unaffordable capital purchases continue to reject;
- fleet sale/withdrawal/reassignment is out of scope.

Therefore once recurring expense pushes Standard below the affordability floor, the city can enter an absorbing state where the player cannot fund new construction and cannot divest deployed vehicles. This is not a minor balance note.

At the proposed constants, two four-train Metro lines cost `$20,000 / game day`; from the default `$120,000`, six days exhaust the starting capital. At 4x speed a 1,200-second game day lasts five real minutes, so that example can exhaust starting capital in about 30 real minutes if nothing else changes.

HPA-645 knowingly accepts that temporary imbalance only because active development has no released users. **HPA-646 is the required next HPA-335 implementation slice** and must add the smallest positive transit-income/fare/subsidy rule before Phase 5 is considered complete. Do not leave revenue as an indefinite “maybe later” item.

HPA-646 should remain narrow and city-level unless real gameplay requires per-line revenue attribution.

## Other bounded risks

### Boundary gaming is accepted

Pausing a route just before midnight avoids that day's charge; resuming just after midnight defers liability until the next boundary. Fixing this requires active-time accumulation/proration/history and is outside HPA-645.

### Broken routes are free while broken

This slice charges operational service, not asset ownership/maintenance. Charging parked/broken fleets would be a second economic rule.

### Values are explicit tuning constants

The initial 400 / 2,500 numbers are deliberately independent from capital prices. HPA-646 may change overall economy balance without forcing a recurring-cost architecture change.

## Verification strategy

### Operating-cost authority

Unit tests in `operating_cost.rs` lock:

- Bus = 400/vehicle/day and Metro = 2,500/vehicle/day;
- saturating fleet multiplication;
- actual zero for zero fleet, inactive route, empty legs, missing current path, or broken route;
- actual assigned-fleet cost for a usable active route;
- estimate `Some(required × mode cost)` only for zero fleet with known requirement;
- estimate `None` after fleet assignment;
- city total uses the same actual line rule for Bus + Metro;
- no day transition does not deduct;
- Standard day transition subtracts once and may cross below zero;
- Creative does not deduct.

No Campaign invariant test and no multi-day multiplier test.

### Public tick and regression locks

Reuse `crates/caelum-core/tests/service_control.rs` fixtures:

1. Standard one-Bus fixture: budget 399 → cross midnight → -1; game remains running.
2. Creative equivalent: budget unchanged and `dailyOperatingCost == 400`.
3. Coarse tick across midnight equals equivalent split ticks for time/day/budget.
4. Save/restore immediately after charge; same-day tick does not double-charge.
5. Route pause publishes actual daily cost 0 and avoids the boundary charge.
6. Broken service costs/charges 0.
7. Global pause keeps active Bus `dailyOperatingCost == 400 × assignedFleet` while `nextVehicleCost` remains suppressed.

### Wire and frontend

Update direct non-null `ServiceMetrics` fixtures and exact JSON with both fields.

Frontend tests lock:

- selector forwards actual and estimate without formulae;
- zero-fleet Lines block uses estimate only;
- deployed Lines block uses actual only;
- Topbar sums only actual deployed liabilities and excludes a zero-fleet estimate;
- Bus + Metro actual values aggregate correctly;
- route/global pause semantics are rendered from Rust values, not recomputed.

No Playwright midnight scenario.

## Review resolutions

The two planning reviews produced these accepted changes:

1. Remove `crossed_days`; charge once per observed midnight.
2. Keep route-active and global-pause inputs separate and lock that invariant.
3. Lock Creative nominal parity.
4. Split actual `dailyOperatingCost` from optional `estimatedDailyOperatingCost`.
5. Use one `line_daily_operating_cost` rule for both billing and service projection; no duplicate charge predicate.
6. Add one Topbar current-daily-cost aggregate from actual Rust-published fields only.
7. Remove Campaign-specific gating/testing per the repository's in-flight-reduction rule.
8. Name the adjacent bool semantics explicitly (`route_active`, `globally_paused`) and use named locals at call sites.
9. Make the Standard absorbing-budget state an explicit high-impact risk and make HPA-646 the required next Phase 5 slice.

One suggestion is intentionally **not** adopted: `apply_day_boundary_charge` does not reuse `CostPolicy::from_snapshot`. The capital-authorization module and recurring-settlement module have different reasons to change; a direct `EconomyPreset::Creative` match is simpler than coupling the modules solely to avoid a trivial two-variant match.

## Non-goals

- HPA-646 revenue implementation in this PR;
- fares, subsidies, ticket revenue, transfer attribution, or net profit in HPA-645;
- per-distance, per-hour, occupancy, congestion, vehicle-age, fuel, energy, staffing, or maintenance costs;
- active-time history, proration, refunds, partial-day settlement, transaction logs, or accounting periods;
- multi-day catch-up billing or skipped-boundary settlement;
- budgets by department, cost centres, ledgers, loans, bonds, taxes, bankruptcy, or game-over rules;
- a finance dashboard/history/chart beyond the single Topbar daily-cost readout;
- target editing after deployment, fleet withdrawal/sale/reassignment/refund, holding, or optimization;
- a generic recurring-expense system, dependency, feature flag, schema migration, or backward-compatibility adapter;
- changes to capital purchase affordability or `CostPolicy`.